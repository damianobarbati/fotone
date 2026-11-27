use crate::{
    config::{Config, Headers},
    files::{Asset, Content, Files, Lookup, get_encodings, mime_type},
    routing::{decode_path, encode_path, public_path, redirect_target, select_language_path},
};
use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode, Version,
    body::{Body, Frame, Incoming, SizeHint},
    header::{self, HeaderMap, HeaderName, HeaderValue},
};
use std::{
    convert::Infallible,
    io,
    net::IpAddr,
    path::Path,
    pin::Pin,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Instant,
};
use tokio::io::AsyncReadExt;
use tokio_util::io::ReaderStream;

const METHODS: &str = "GET, HEAD";
const CORS_METHODS: &str = "GET, HEAD, OPTIONS";
static TAGS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"(?:W/)?"[^"]*""#).expect("literal regex"));

pub struct State {
    pub config: Config,
    pub ready: AtomicBool,
    files: Arc<Files>,
}

impl State {
    pub fn new(config: Config) -> io::Result<Self> {
        let files = Arc::new(Files::new(&config.directory)?);
        Ok(Self {
            config,
            files,
            ready: AtomicBool::new(true),
        })
    }

    pub async fn serve(
        &self,
        request: Request<Incoming>,
        peer: IpAddr,
    ) -> Result<Response<ResponseBody>, Infallible> {
        let log = (!self.config.quiet).then(|| RequestLog {
            started: Instant::now(),
            address: self.config.client_address(peer, request.headers()),
            method: request.method().clone(),
            path: request.uri().path().to_owned(),
            status: StatusCode::INTERNAL_SERVER_ERROR,
        });

        let mut response = match self.route(&request).await {
            Ok(response) => response,
            Err(error) => {
                if !self.config.quiet {
                    eprintln!("{error}");
                }

                let path = decode_path(request.uri().path());
                let reply = Reply::new(self, &request, path.as_deref().unwrap_or("/"));
                reply.text(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
            }
        };

        if let Some(mut log) = log {
            log.status = response.status();
            response.body_mut().log = Some(log);
        }

        Ok(response)
    }

    async fn route(&self, request: &Request<Incoming>) -> io::Result<Response<ResponseBody>> {
        let path = decode_path(request.uri().path());
        let reply = Reply::new(self, request, path.as_deref().unwrap_or("/"));
        let valid_query = request
            .uri()
            .query()
            .is_none_or(|query| !query.contains(|c: char| c.is_control() || c == '#'));

        let Some(decoded) = path.filter(|_| valid_query) else {
            return Ok(reply.text(StatusCode::BAD_REQUEST, "Bad request."));
        };

        if request.version() == Version::HTTP_11 && !request.headers().contains_key(header::HOST) {
            return Ok(reply.text(StatusCode::BAD_REQUEST, "Bad request."));
        }

        let method = request.method();
        if *method == Method::OPTIONS && self.config.cors {
            return Ok(reply.preflight());
        }

        let path = if self.config.strip_trailing_slash && decoded.len() > 1 {
            decoded.strip_suffix('/').unwrap_or(&decoded)
        } else {
            &decoded
        };

        if let Some(auth) = &self.config.auth
            && !auth
                .allows(path, request.headers().get(header::AUTHORIZATION))
                .await
        {
            let response = reply.single_header(
                StatusCode::UNAUTHORIZED,
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Basic realm=\"fotone\""),
            );
            return Ok(response);
        }

        if *method != Method::GET && *method != Method::HEAD {
            let allow = if self.config.cors {
                CORS_METHODS
            } else {
                METHODS
            };
            return Ok(reply.single_header(
                StatusCode::METHOD_NOT_ALLOWED,
                header::ALLOW,
                HeaderValue::from_static(allow),
            ));
        }

        if path == "/health" {
            let ready = self.ready.load(Ordering::Relaxed);
            let (status, payload) = if ready {
                (
                    StatusCode::OK,
                    br#"{"code":"OK","message":"Ready."}"#.as_slice(),
                )
            } else {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    br#"{"code":"UNAVAILABLE","message":"Unavailable."}"#.as_slice(),
                )
            };

            return Ok(reply.json(status, Bytes::from_static(payload)));
        }

        if path == "/env"
            && let Some(payload) = &self.config.env_json
        {
            return Ok(reply.json(StatusCode::OK, payload.clone()));
        }

        if let Some((destination, status)) = self
            .config
            .redirects
            .iter()
            .find_map(|rule| rule.apply(path).map(|target| (target, rule.status)))
            && redirect_target(&destination)
        {
            return Ok(reply.redirect(
                StatusCode::from_u16(status).expect("validated status"),
                destination,
            ));
        }

        if path == "/"
            && let Some(redirect) = &self.config.language_redirect
        {
            let preferences = request
                .headers()
                .get_all(header::ACCEPT_LANGUAGE)
                .iter()
                .filter_map(|value| value.to_str().ok());
            let target = select_language_path(preferences, &redirect.languages, &redirect.default);
            let mut response =
                reply.redirect(StatusCode::FOUND, reply.with_query(target.to_owned()));
            let headers = response.headers_mut();
            extend_vary(headers, "Accept-Language");
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            return Ok(response);
        }

        if decoded != path {
            return Ok(reply.canonical_redirect(path));
        }

        let relative = if self.config.base_path == "/" {
            Some(path)
        } else if path == self.config.base_path {
            Some("/")
        } else {
            path.strip_prefix(self.config.base_path.as_str())
                .filter(|suffix| suffix.starts_with('/'))
        };

        reply.static_file(path, relative).await
    }
}

struct RequestLog {
    started: Instant,
    address: IpAddr,
    method: Method,
    path: String,
    status: StatusCode,
}

pub struct ResponseBody {
    body: UnsyncBoxBody<Bytes, io::Error>,
    log: Option<RequestLog>,
}

impl ResponseBody {
    fn full(bytes: Bytes) -> Self {
        let body = Full::new(bytes)
            .map_err(|never| match never {})
            .boxed_unsync();
        Self { body, log: None }
    }

    fn stream(file: std::fs::File, size: u64) -> Self {
        let file = tokio::fs::File::from_std(file).take(size);
        let frames = ReaderStream::with_capacity(file, 64 * 1024).map_ok(Frame::data);
        let body = StreamBody::new(frames).boxed_unsync();
        Self { body, log: None }
    }
}

impl Body for ResponseBody {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
        Pin::new(&mut self.body).poll_frame(context)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

impl Drop for ResponseBody {
    fn drop(&mut self) {
        if let Some(log) = self.log.take() {
            let stamp = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
            let path = log.path.replace(char::is_control, "");
            let elapsed = log.started.elapsed().as_secs_f64() * 1_000.0;
            println!(
                "{stamp} {} {} {path} {} {elapsed:.1}ms",
                log.address,
                log.method,
                log.status.as_u16()
            );
        }
    }
}

struct Reply<'a> {
    state: &'a State,
    request: &'a Request<Incoming>,
    headers: Option<HeaderMap<Option<HeaderValue>>>,
}

impl<'a> Reply<'a> {
    fn new(state: &'a State, request: &'a Request<Incoming>, path: &str) -> Self {
        let config = &state.config;
        let mut headers = None;

        let mut add = |values: &Headers| {
            let headers = headers.get_or_insert_with(HeaderMap::<Option<HeaderValue>>::default);

            for (name, value) in values {
                headers.insert(name, value.clone());
            }
        };

        if !config.headers.is_empty() {
            add(&config.headers);
        }

        for (patterns, values) in &config.header_rules {
            if patterns.iter().any(|pattern| pattern.matches(path)) {
                add(values);
            }
        }

        Self {
            state,
            request,
            headers,
        }
    }

    fn apply_headers(&self, target: &mut HeaderMap) {
        if let Some(headers) = &self.headers {
            for (name, value) in headers {
                if let Some(value) = value {
                    target.insert(name, value.clone());
                } else {
                    target.remove(name);
                }
            }
        }
    }

    fn response(
        &self,
        status: StatusCode,
        headers: HeaderMap,
        body: ResponseBody,
    ) -> Response<ResponseBody> {
        let mut response = Response::new(body);
        *response.status_mut() = status;
        *response.headers_mut() = headers;
        response
    }

    fn simple(
        &self,
        status: StatusCode,
        mut headers: HeaderMap,
        body: Option<Bytes>,
    ) -> Response<ResponseBody> {
        self.apply_headers(&mut headers);

        if let Some(bytes) = &body {
            headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
        }

        let bytes = if self.request.method() == Method::HEAD {
            Bytes::new()
        } else {
            body.unwrap_or_default()
        };
        self.response(status, headers, ResponseBody::full(bytes))
    }

    fn single_header(
        &self,
        status: StatusCode,
        name: HeaderName,
        value: HeaderValue,
    ) -> Response<ResponseBody> {
        let mut headers = HeaderMap::new();
        headers.insert(name, value);
        self.simple(status, headers, None)
    }

    fn text(&self, status: StatusCode, text: &'static str) -> Response<ResponseBody> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=utf-8"),
        );
        self.simple(status, headers, Some(Bytes::from_static(text.as_bytes())))
    }

    fn json(&self, status: StatusCode, bytes: Bytes) -> Response<ResponseBody> {
        let size = bytes.len();
        let mut response = self.simple(status, HeaderMap::new(), Some(bytes));
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
        response
    }

    fn redirect(&self, status: StatusCode, destination: String) -> Response<ResponseBody> {
        match HeaderValue::from_str(&destination) {
            Ok(location) => self.single_header(status, header::LOCATION, location),
            Err(_) => self.text(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error."),
        }
    }

    fn with_query(&self, mut destination: String) -> String {
        if let Some(query) = self.request.uri().query() {
            destination.push('?');
            destination.push_str(query);
        }

        destination
    }

    fn canonical_redirect(&self, path: &str) -> Response<ResponseBody> {
        self.redirect(
            StatusCode::MOVED_PERMANENTLY,
            self.with_query(encode_path(path)),
        )
    }

    fn preflight(&self) -> Response<ResponseBody> {
        let headers = self.request.headers();

        if headers
            .get(header::ACCESS_CONTROL_REQUEST_METHOD)
            .is_some_and(|value| !matches!(value.as_bytes(), b"GET" | b"HEAD" | b"OPTIONS"))
        {
            return self.single_header(
                StatusCode::METHOD_NOT_ALLOWED,
                header::ALLOW,
                HeaderValue::from_static(CORS_METHODS),
            );
        }

        let mut response_headers = HeaderMap::new();
        response_headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(CORS_METHODS),
        );

        if let Some(value) = headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
            response_headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, value.clone());
        }

        self.simple(StatusCode::NO_CONTENT, response_headers, None)
    }

    async fn static_file(
        &self,
        path: &str,
        relative: Option<&str>,
    ) -> io::Result<Response<ResponseBody>> {
        let config = &self.state.config;
        let files = &self.state.files;
        let encoding = self
            .request
            .headers()
            .get(header::ACCEPT_ENCODING)
            .and_then(|value| value.to_str().ok());
        let variants = get_encodings(encoding);

        if let Some(relative) = relative.filter(|value| public_path(value)) {
            let rewrite = config.rewrites.iter().find_map(|rule| rule.apply(path));

            if config.clean_urls
                && relative.ends_with(".html")
                && !matches!(files.lookup(relative, variants).await?, Lookup::Missing)
            {
                return Ok(self.canonical_redirect(&path[..path.len() - ".html".len()]));
            }

            let target = match &rewrite {
                Some(path) => decode_path(path),
                None => Some(std::borrow::Cow::Borrowed(relative)),
            };

            let mut asset = Lookup::Missing;

            if let Some(target) = target {
                asset = files.lookup(&target, variants).await?;

                if matches!(asset, Lookup::Missing)
                    && rewrite.is_none()
                    && config.extension_fallback
                    && target != "/"
                    && Path::new(target.as_ref()).extension().is_none()
                {
                    asset = files.lookup(&format!("{target}.html"), variants).await?;
                }
            }

            if matches!(asset, Lookup::Missing) && rewrite.is_none() {
                let directory = relative.trim_end_matches('/');
                asset = files
                    .lookup(&format!("{directory}/index.html"), variants)
                    .await?;
            }

            if let Some(spa) = &config.spa
                && matches!(asset, Lookup::Missing)
                && rewrite.is_none()
                && Path::new(relative).extension().is_none()
                && !config
                    .spa_excludes
                    .iter()
                    .any(|pattern| pattern.matches(path))
            {
                asset = files.lookup(spa, variants).await?;
            }

            match asset {
                Lookup::Unacceptable => {
                    let mut headers = HeaderMap::new();
                    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
                    headers.insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/plain; charset=utf-8"),
                    );
                    return Ok(self.simple(
                        StatusCode::NOT_ACCEPTABLE,
                        headers,
                        Some(Bytes::from_static(b"Not acceptable.")),
                    ));
                }
                Lookup::Found(asset) => {
                    if let Some(response) = self.asset(asset, StatusCode::OK).await? {
                        return Ok(response);
                    }
                }
                Lookup::Missing => {}
            }
        }

        if let Lookup::Found(asset) = files.lookup("/404.html", variants).await?
            && let Some(response) = self.asset(asset, StatusCode::NOT_FOUND).await?
        {
            return Ok(response);
        }

        Ok(self.text(StatusCode::NOT_FOUND, "Not found."))
    }

    async fn asset(
        &self,
        asset: Asset,
        status: StatusCode,
    ) -> io::Result<Option<Response<ResponseBody>>> {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CACHE_CONTROL,
            self.state.config.cache_control.clone(),
        );
        let (modified, tag) = asset.validators();
        headers.insert(header::LAST_MODIFIED, modified);
        headers.insert(header::ETAG, tag);
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(mime_type(&asset.path)),
        );
        self.apply_headers(&mut headers);
        extend_vary(&mut headers, "Accept-Encoding");

        if status == StatusCode::OK && is_fresh(self.request.headers(), &headers) {
            headers.remove(header::CONTENT_TYPE);
            return Ok(Some(self.response(
                StatusCode::NOT_MODIFIED,
                headers,
                ResponseBody::full(Bytes::new()),
            )));
        }

        let size = asset.size();
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(size));

        if asset.encoding.name() != "identity" {
            headers.insert(
                header::CONTENT_ENCODING,
                HeaderValue::from_static(asset.encoding.name()),
            );
        }

        let mut body = ResponseBody::full(Bytes::new());

        if self.request.method() != Method::HEAD {
            match self.state.files.content(asset).await? {
                Some(Content::Buffered(bytes)) => body = ResponseBody::full(bytes),
                Some(Content::Stream(file)) => body = ResponseBody::stream(file, size),
                None => return Ok(None),
            }
        }

        Ok(Some(self.response(status, headers, body)))
    }
}

fn extend_vary(headers: &mut HeaderMap, name: &'static str) {
    let vary = headers
        .get(header::VARY)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    if let Some(vary) = vary {
        if vary
            .split(',')
            .any(|value| value.trim() == "*" || value.trim().eq_ignore_ascii_case(name))
        {
            return;
        }

        if let Ok(value) = HeaderValue::from_str(&format!("{vary}, {name}")) {
            headers.insert(header::VARY, value);
        }
    } else {
        headers.insert(header::VARY, HeaderValue::from_static(name));
    }
}

fn weak_tag(value: &str) -> &str {
    value.strip_prefix("W/").unwrap_or(value)
}

fn is_fresh(request: &HeaderMap, response: &HeaderMap) -> bool {
    if request.contains_key(header::IF_NONE_MATCH) {
        let values = request.get_all(header::IF_NONE_MATCH);
        let mut candidates = values
            .iter()
            .filter_map(|value| value.to_str().ok())
            .peekable();

        if candidates
            .peek()
            .is_some_and(|candidate| candidate.trim() == "*")
            && values.iter().count() == 1
        {
            return true;
        }

        let Some(current) = response
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };

        return candidates.any(|list| {
            TAGS.find_iter(list)
                .any(|tag| weak_tag(tag.as_str()) == weak_tag(current))
        });
    }

    let date = |headers: &HeaderMap, name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| httpdate::parse_http_date(value).ok())
    };

    date(request, header::IF_MODIFIED_SINCE)
        .zip(date(response, header::LAST_MODIFIED))
        .is_some_and(|(since, modified)| modified <= since)
}
