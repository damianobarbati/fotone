use crate::routing::public_path;
use bytes::Bytes;
use hyper::header::HeaderValue;
use rustix::{
    fd::OwnedFd,
    fs::{AtFlags, FileType, Mode, OFlags, Stat, fstat, open, openat, statat},
    io::Errno,
};
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    fs::File,
    io::{self, Read},
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

const FILE_LIMIT: u64 = 1024 * 1024;
const BUDGET: usize = 16 * FILE_LIMIT as usize;
const ENTRY_LIMIT: usize = 256;
const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const FILE_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::NONBLOCK)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

#[derive(Clone, Copy, PartialEq)]
pub enum Encoding {
    Br,
    Gzip,
    Identity,
}

impl Encoding {
    pub fn name(self) -> &'static str {
        match self {
            Self::Br => "br",
            Self::Gzip => "gzip",
            Self::Identity => "identity",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Br => ".br",
            Self::Gzip => ".gz",
            Self::Identity => "",
        }
    }
}

type Variants = [(Encoding, u16); 3];

fn quality(raw: &str) -> u16 {
    let (whole, decimals) = raw.split_once('.').unwrap_or((raw, ""));
    if decimals.len() > 3 || !decimals.bytes().all(|character| character.is_ascii_digit()) {
        return 0;
    }

    match whole {
        "1" if decimals.bytes().all(|character| character == b'0') => 1000,
        "0" => decimals.parse::<u16>().unwrap_or(0) * 10_u16.pow((3 - decimals.len()) as u32),
        _ => 0,
    }
}

pub fn get_encodings(header: Option<&str>) -> Variants {
    use Encoding::{Br, Gzip, Identity};

    match header {
        None | Some("" | "identity") => return [(Identity, 1000), (Br, 0), (Gzip, 0)],
        Some("br") => return [(Br, 1000), (Identity, 1000), (Gzip, 0)],
        _ => {}
    }

    let mut wildcard = None;
    let mut brotli = None;
    let mut gzip = None;
    let mut identity = None;
    let accepted = header.unwrap_or_default().to_ascii_lowercase();

    for item in accepted.split(',') {
        let mut fields = item.split(';').map(str::trim);
        let entry = match fields.next() {
            Some("br") => &mut brotli,
            Some("gzip") => &mut gzip,
            Some("identity") => &mut identity,
            Some("*") => &mut wildcard,
            _ => continue,
        };
        *entry = Some(
            fields
                .find_map(|parameter| parameter.strip_prefix("q="))
                .map_or(1000, quality),
        );
    }

    let mut result = [
        (Br, brotli.or(wildcard).unwrap_or(0)),
        (Gzip, gzip.or(wildcard).unwrap_or(0)),
        (
            Identity,
            identity.unwrap_or(if wildcard == Some(0) { 0 } else { 1000 }),
        ),
    ];
    result.sort_by_key(|(_, rank)| std::cmp::Reverse(*rank));
    result
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct FileId {
    device: i128,
    inode: u64,
    size: u64,
    modified: i128,
    changed: i128,
}

impl FileId {
    fn from_stat(info: Stat) -> Option<Self> {
        if FileType::from_raw_mode(info.st_mode) != FileType::RegularFile {
            return None;
        }

        Some(Self {
            device: i128::from(info.st_dev),
            inode: info.st_ino,
            size: info.st_size.try_into().ok()?,
            modified: i128::from(info.st_mtime) * 1_000_000_000 + i128::from(info.st_mtime_nsec),
            changed: i128::from(info.st_ctime) * 1_000_000_000 + i128::from(info.st_ctime_nsec),
        })
    }
}

fn unavailable(error: Errno) -> bool {
    matches!(
        error,
        Errno::NOENT | Errno::NOTDIR | Errno::LOOP | Errno::ACCESS | Errno::NAMETOOLONG
    )
}

pub enum Lookup {
    Missing,
    Unacceptable,
    Found(Asset),
}

pub struct Asset {
    parent: Arc<OwnedFd>,
    name: String,
    pub path: String,
    pub encoding: Encoding,
    id: FileId,
}

fn hex(value: i128) -> String {
    if value < 0 {
        format!("-{:x}", value.unsigned_abs())
    } else {
        format!("{value:x}")
    }
}

struct Validators {
    id: FileId,
    encoding: Encoding,
    modified: HeaderValue,
    tag: HeaderValue,
}

thread_local! {
    static VALIDATORS: RefCell<[Option<Validators>; 16]> = const { RefCell::new([const { None }; 16]) };
}

impl Asset {
    pub fn size(&self) -> u64 {
        self.id.size
    }

    pub fn validators(&self) -> (HeaderValue, HeaderValue) {
        VALIDATORS.with_borrow_mut(|slots| {
            let index = self.id.inode as usize % slots.len();
            let slot = &mut slots[index];
            if let Some(hit) = slot
                && hit.id == self.id
                && hit.encoding == self.encoding
            {
                return (hit.modified.clone(), hit.tag.clone());
            }
            let modified = HeaderValue::from_str(&self.modified()).expect("HTTP date");
            let tag = HeaderValue::from_str(&self.tag()).expect("valid ETag");
            *slot = Some(Validators {
                id: self.id,
                encoding: self.encoding,
                modified: modified.clone(),
                tag: tag.clone(),
            });
            (modified, tag)
        })
    }

    fn modified(&self) -> String {
        let seconds = self.id.modified.div_euclid(1_000_000_000) as i64;
        chrono::DateTime::from_timestamp(seconds, 0).map_or_else(
            || "Thu, 01 Jan 1970 00:00:00 GMT".into(),
            |date| date.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
        )
    }

    fn tag(&self) -> String {
        format!(
            "W/\"{:x}-{}-{}-{}\"",
            self.id.size,
            hex(self.id.modified),
            hex(self.id.changed),
            self.encoding.name()
        )
    }

    fn open(&self) -> io::Result<Option<File>> {
        let fd = match openat(&*self.parent, self.name.as_str(), FILE_FLAGS, Mode::empty()) {
            Ok(fd) => fd,
            Err(error) if unavailable(error) => return Ok(None),
            Err(error) => return Err(error.into()),
        };

        let current = FileId::from_stat(fstat(&fd)?);
        Ok((current == Some(self.id)).then(|| File::from(fd)))
    }
}

struct Buffer {
    data: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}

impl AsRef<[u8]> for Buffer {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}

type ReadResult = Result<Option<Bytes>, Arc<io::Error>>;
type Pending = watch::Receiver<Option<ReadResult>>;

#[derive(Default)]
struct Cache {
    bodies: HashMap<FileId, Bytes>,
    pending: HashMap<FileId, Pending>,
    order: VecDeque<FileId>,
}

enum CacheLookup {
    Hit(Bytes),
    Pending(Pending),
    Stream(Asset),
}

pub enum Content {
    Buffered(Bytes),
    Stream(File),
}

pub struct Files {
    root: Arc<OwnedFd>,
    cache: Mutex<Cache>,
    memory: Arc<Semaphore>,
}

impl Files {
    pub fn new(directory: &Path) -> io::Result<Self> {
        Ok(Self {
            root: Arc::new(open(directory, DIR_FLAGS, Mode::empty())?),
            cache: Mutex::new(Cache::default()),
            memory: Arc::new(Semaphore::new(BUDGET)),
        })
    }

    pub async fn lookup(&self, path: &str, variants: Variants) -> io::Result<Lookup> {
        if path == "/" || path.ends_with('/') || !public_path(path) {
            return Ok(Lookup::Missing);
        }

        let root = self.root.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || Self::find(root, path, variants)).await?
    }

    fn find(root: Arc<OwnedFd>, path: String, variants: Variants) -> io::Result<Lookup> {
        let mut parent = root;
        let mut segments = path[1..].split('/').peekable();
        let mut name = "";

        while let Some(segment) = segments.next() {
            if segments.peek().is_none() {
                name = segment;
                break;
            }

            match openat(&*parent, segment, DIR_FLAGS, Mode::empty()) {
                Ok(fd) => parent = Arc::new(fd),
                Err(error) if unavailable(error) => return Ok(Lookup::Missing),
                Err(error) => return Err(error.into()),
            }
        }

        for (encoding, rank) in variants {
            let candidate = format!("{name}{}", encoding.suffix());
            let id = match statat(&*parent, candidate.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
                Ok(info) => FileId::from_stat(info),
                Err(error) if unavailable(error) => None,
                Err(error) => return Err(error.into()),
            };

            if let Some(id) = id {
                if rank == 0 {
                    return Ok(Lookup::Unacceptable);
                }
                return Ok(Lookup::Found(Asset {
                    parent,
                    name: candidate,
                    path,
                    encoding,
                    id,
                }));
            }
        }

        Ok(Lookup::Missing)
    }

    pub async fn content(self: &Arc<Self>, asset: Asset) -> io::Result<Option<Content>> {
        let asset = match self.cached(asset) {
            CacheLookup::Hit(body) => return Ok(Some(Content::Buffered(body))),
            CacheLookup::Pending(receiver) => return Self::wait(receiver).await,
            CacheLookup::Stream(asset) => asset,
        };

        tokio::task::spawn_blocking(move || asset.open().map(|file| file.map(Content::Stream)))
            .await?
    }

    fn cached(self: &Arc<Self>, asset: Asset) -> CacheLookup {
        if asset.size() > FILE_LIMIT {
            return CacheLookup::Stream(asset);
        }

        let id = asset.id;
        let mut cache = self.cache.lock().expect("body cache");

        if let Some(body) = cache.bodies.get(&id) {
            return CacheLookup::Hit(body.clone());
        }

        if let Some(pending) = cache.pending.get(&id) {
            return CacheLookup::Pending(pending.clone());
        }

        let size = id.size as usize;
        while (cache.bodies.len() + cache.pending.len() >= ENTRY_LIMIT
            || self.memory.available_permits() < size)
            && let Some(oldest) = cache.order.pop_front()
        {
            cache.bodies.remove(&oldest);
        }

        if cache.pending.len() < ENTRY_LIMIT
            && let Ok(permit) = self.memory.clone().try_acquire_many_owned(size as u32)
        {
            let (sender, receiver) = watch::channel(None);
            cache.pending.insert(id, receiver.clone());
            let files = self.clone();
            tokio::task::spawn_blocking(move || {
                let result = Self::buffer(asset, permit).map_err(Arc::new);
                let mut cache = files.cache.lock().expect("body cache");
                cache.pending.remove(&id);
                if let Ok(Some(body)) = &result {
                    cache.bodies.insert(id, body.clone());
                    cache.order.push_back(id);
                }
                drop(cache);
                sender.send_replace(Some(result));
            });
            return CacheLookup::Pending(receiver);
        }
        CacheLookup::Stream(asset)
    }

    async fn wait(mut receiver: Pending) -> io::Result<Option<Content>> {
        receiver.changed().await.map_err(io::Error::other)?;
        let result = receiver.borrow().clone().expect("completed file read");
        result
            .map(|body| body.map(Content::Buffered))
            .map_err(|error| io::Error::new(error.kind(), error))
    }

    fn buffer(asset: Asset, permit: OwnedSemaphorePermit) -> io::Result<Option<Bytes>> {
        let Some(file) = asset.open()? else {
            return Ok(None);
        };
        let mut data = Vec::with_capacity(asset.size() as usize);
        (&file).take(asset.size()).read_to_end(&mut data)?;

        if data.len() as u64 != asset.size() || FileId::from_stat(fstat(&file)?) != Some(asset.id) {
            return Ok(None);
        }

        Ok(Some(Bytes::from_owner(Buffer {
            data,
            _permit: permit,
        })))
    }
}

pub fn mime_type(path: &str) -> &'static str {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let extension = extension.to_ascii_lowercase();

    match extension.as_str() {
        "avif" => "image/avif",
        "cjs" | "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "gif" => "image/gif",
        "gz" => "application/gzip",
        "htm" | "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpeg" | "jpg" => "image/jpeg",
        "json" | "map" => "application/json; charset=utf-8",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "ogg" => "audio/ogg",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "xml" => "application/xml; charset=utf-8",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_asset(files: &Files, path: &str) -> Asset {
        let found = Files::find(files.root.clone(), path.to_owned(), get_encodings(None))
            .expect("look up test asset");
        let Lookup::Found(asset) = found else {
            unreachable!("missing test asset")
        };
        asset
    }

    #[test]
    fn concurrent_requests_share_a_read_after_the_first_request_is_dropped() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .build()
            .expect("test runtime");

        runtime.block_on(async {
            let files = Arc::new(Files::new(Path::new(env!("CARGO_MANIFEST_DIR"))).expect("files"));
            let (release, blocked) = std::sync::mpsc::channel();
            let blocker = tokio::task::spawn_blocking(move || blocked.recv());

            let first = files.cached(test_asset(&files, "/Cargo.toml"));
            let CacheLookup::Pending(second) = files.cached(test_asset(&files, "/Cargo.toml"))
            else {
                unreachable!()
            };
            let CacheLookup::Pending(third) = files.cached(test_asset(&files, "/Cargo.toml"))
            else {
                unreachable!()
            };
            drop(first);
            release.send(()).expect("release worker");
            blocker.await.expect("worker").expect("released");

            let (a, b) = tokio::join!(Files::wait(second), Files::wait(third));
            let (Ok(Some(Content::Buffered(a))), Ok(Some(Content::Buffered(b)))) = (a, b) else {
                unreachable!()
            };
            assert_eq!(a.as_ptr(), b.as_ptr());
            assert_eq!(files.memory.available_permits(), BUDGET - a.len());

            tokio::task::spawn_blocking(|| ())
                .await
                .expect("file read finished");
            let mut cache = files.cache.lock().expect("body cache");
            cache.bodies.clear();
            drop(a);
            assert_eq!(files.memory.available_permits(), BUDGET - b.len());
            drop(b);
            assert_eq!(files.memory.available_permits(), BUDGET);
        });
    }

    #[tokio::test]
    async fn streams_when_an_evicted_body_still_owns_the_memory() {
        let mut files = Files::new(Path::new(env!("CARGO_MANIFEST_DIR"))).expect("files");
        let large = test_asset(&files, "/Cargo.lock");
        files.memory = Arc::new(Semaphore::new(large.size() as usize));
        let files = Arc::new(files);

        let active = files
            .content(test_asset(&files, "/Cargo.toml"))
            .await
            .expect("small file");
        let fallback = files.content(large).await.expect("large file");
        assert!(matches!(fallback, Some(Content::Stream(_))));
        drop(active);

        let buffered = files
            .content(test_asset(&files, "/Cargo.lock"))
            .await
            .expect("large file");
        assert!(matches!(buffered, Some(Content::Buffered(_))));
    }

    #[tokio::test]
    async fn failed_open_releases_memory_and_allows_retry_for_the_same_identity() {
        let files = Arc::new(Files::new(Path::new(env!("CARGO_MANIFEST_DIR"))).expect("files"));
        let mut missing = test_asset(&files, "/Cargo.toml");
        missing.name = "missing-test-file".into();
        assert!(files.content(missing).await.expect("lookup").is_none());
        assert_eq!(files.memory.available_permits(), BUDGET);
        let body = files
            .content(test_asset(&files, "/Cargo.toml"))
            .await
            .expect("retry");
        assert!(matches!(body, Some(Content::Buffered(_))));
    }
}
