mod config;
mod files;
mod routing;
mod server;

use config::{Config, Options};
use hyper::service::service_fn;
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder,
};
use server::State;
use std::{
    env,
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    process::ExitCode,
    sync::{Arc, atomic::Ordering},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    signal::unix::{SignalKind, signal},
    sync::watch,
    task::JoinSet,
    time::{Instant, Sleep, sleep, timeout},
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("fotone: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::parse(env::args().skip(1))?;

    if options.flag("help") {
        Options::help();
        return Ok(());
    }

    if options.flag("version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let config = Config::load(&options)?;
    let parallelism = std::thread::available_parallelism().map_or(1, usize::from);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .max_blocking_threads(parallelism.max(8))
        .enable_all()
        .build()?;
    runtime.block_on(listen(config))?;
    Ok(())
}

async fn listen(config: Config) -> io::Result<()> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let state = Arc::new(State::new(config)?);
    let listener = TcpListener::bind((state.config.host.as_str(), state.config.port)).await?;
    let (shutdown, stopping) = watch::channel(false);
    let mut connections = JoinSet::new();

    if !state.config.quiet {
        println!("Listening on http://{}", listener.local_addr()?);
    }

    loop {
        tokio::select! {
            biased;
            _ = interrupt.recv() => break,
            _ = terminate.recv() => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            incoming = listener.accept() => {
                let (socket, peer) = match incoming {
                    Ok(accepted) => accepted,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error),
                };
                let _ = socket.set_nodelay(true);
                connections.spawn(serve_connection(socket, peer, state.clone(), stopping.clone()));
            }
        }
    }

    state.ready.store(false, Ordering::Relaxed);
    drop(listener);
    let _ = shutdown.send(true);

    if timeout(Duration::from_secs(10), async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.shutdown().await;
    }

    Ok(())
}

async fn serve_connection(
    socket: TcpStream,
    peer: SocketAddr,
    state: Arc<State>,
    mut stopping: watch::Receiver<bool>,
) {
    let transport = TokioIo::new(IdleStream::new(socket, state.config.timeout));
    let builder = Builder::new(TokioExecutor::new());
    let service = service_fn(move |request| {
        let state = state.clone();
        async move { state.serve(request, peer.ip()).await }
    });
    let connection = builder.serve_connection(transport, service);
    tokio::pin!(connection);

    tokio::select! {
        _ = &mut connection => {}
        _ = stopping.changed() => {
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        }
    }
}

struct IdleStream {
    socket: TcpStream,
    timeout: Duration,
    timer: Option<Pin<Box<Sleep>>>,
}

impl IdleStream {
    fn new(socket: TcpStream, timeout: Duration) -> Self {
        Self {
            socket,
            timeout,
            timer: (!timeout.is_zero()).then(|| Box::pin(sleep(timeout))),
        }
    }

    fn reset(&mut self) {
        if let Some(timer) = &mut self.timer {
            timer.as_mut().reset(Instant::now() + self.timeout);
        }
    }

    fn pending<T>(&mut self, context: &mut Context<'_>) -> Poll<io::Result<T>> {
        if let Some(timer) = &mut self.timer
            && timer.as_mut().poll(context).is_ready()
        {
            return Poll::Ready(Err(io::ErrorKind::TimedOut.into()));
        }

        Poll::Pending
    }

    fn write_result(
        &mut self,
        result: Poll<io::Result<usize>>,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<usize>> {
        match result {
            Poll::Pending => self.pending(cx),
            Poll::Ready(Ok(written)) if written > 0 => {
                self.reset();
                result
            }
            _ => result,
        }
    }
}

impl AsyncRead for IdleStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.socket).poll_read(cx, buffer);

        match result {
            Poll::Pending => self.pending(cx),
            Poll::Ready(Ok(())) if buffer.filled().len() > before => {
                self.reset();
                result
            }
            _ => result,
        }
    }
}

impl AsyncWrite for IdleStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.socket).poll_write(cx, buffer);
        self.write_result(result, cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.socket).poll_write_vectored(cx, buffers);
        self.write_result(result, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.socket.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}
