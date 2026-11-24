use crate::routing::public_path;
use bytes::Bytes;
use rustix::{
    fd::OwnedFd,
    fs::{AtFlags, FileType, Mode, OFlags, Stat, fstat, open, openat, statat},
    io::Errno,
};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{self, Read},
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

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

#[derive(Clone, Copy)]
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

impl Asset {
    pub fn size(&self) -> u64 {
        self.id.size
    }

    pub fn modified(&self) -> String {
        let seconds = self.id.modified.div_euclid(1_000_000_000) as i64;
        chrono::DateTime::from_timestamp(seconds, 0).map_or_else(
            || "Thu, 01 Jan 1970 00:00:00 GMT".into(),
            |date| date.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
        )
    }

    pub fn tag(&self) -> String {
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

#[derive(Default)]
struct Cache {
    bodies: HashMap<FileId, Bytes>,
    order: VecDeque<FileId>,
    bytes: usize,
}

impl Cache {
    fn insert(&mut self, key: FileId, body: Bytes) {
        if self.bodies.contains_key(&key) {
            return;
        }

        while self.bodies.len() >= ENTRY_LIMIT || self.bytes + body.len() > BUDGET {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.bodies.remove(&oldest) {
                self.bytes -= removed.len();
            }
        }

        self.bytes += body.len();
        self.order.push_back(key);
        self.bodies.insert(key, body);
    }
}

pub enum Content {
    Buffered(Bytes, OwnedSemaphorePermit),
    Stream(File),
}

pub struct Files {
    root: Arc<OwnedFd>,
    cache: Mutex<Cache>,
    inflight: Arc<Semaphore>,
}

impl Files {
    pub fn new(directory: &Path) -> io::Result<Self> {
        Ok(Self {
            root: Arc::new(open(directory, DIR_FLAGS, Mode::empty())?),
            cache: Mutex::new(Cache::default()),
            inflight: Arc::new(Semaphore::new(BUDGET)),
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
        if asset.size() <= FILE_LIMIT
            && let Ok(permit) = self
                .inflight
                .clone()
                .try_acquire_many_owned(asset.size() as u32)
        {
            if let Some(body) = self
                .cache
                .lock()
                .expect("body cache")
                .bodies
                .get(&asset.id)
                .cloned()
            {
                return Ok(Some(Content::Buffered(body, permit)));
            }

            let files = self.clone();
            return tokio::task::spawn_blocking(move || files.buffer(asset, permit)).await?;
        }

        tokio::task::spawn_blocking(move || asset.open().map(|file| file.map(Content::Stream)))
            .await?
    }

    fn buffer(&self, asset: Asset, permit: OwnedSemaphorePermit) -> io::Result<Option<Content>> {
        let Some(file) = asset.open()? else {
            return Ok(None);
        };
        let mut data = Vec::with_capacity(asset.size() as usize);
        (&file).take(asset.size()).read_to_end(&mut data)?;

        if data.len() as u64 != asset.size() || FileId::from_stat(fstat(&file)?) != Some(asset.id) {
            return Ok(None);
        }

        let body = Bytes::from(data);
        self.cache
            .lock()
            .expect("body cache")
            .insert(asset.id, body.clone());
        Ok(Some(Content::Buffered(body, permit)))
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
