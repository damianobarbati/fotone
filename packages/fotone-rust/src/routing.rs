use globset::{GlobBuilder, GlobMatcher};
use hyper::Uri;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use regex::Regex;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

const PATH_ESCAPES: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'/')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'!')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')')
    .remove(b'*');
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:([A-Za-z_][A-Za-z0-9_]*)(\*)?$").expect("literal regex"));
static REFERENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r":([A-Za-z_][A-Za-z0-9_]*)").expect("literal regex"));

static LANGUAGE_PREFERENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([a-z]{1,8}(?:-[a-z0-9]{1,8})*)(?:[ \t]*;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$",
    )
    .expect("literal regex")
});

pub fn is_language_tag(value: &str) -> bool {
    LANGUAGE_PREFERENCE
        .captures(value)
        .is_some_and(|preference| preference.get(2).is_none())
}

pub fn select_language_path<'a, 'header>(
    headers: impl Iterator<Item = &'header str>,
    languages: &'a HashMap<String, String>,
    fallback: &'a str,
) -> &'a str {
    let mut result = fallback;
    let mut best_quality = 0.0;

    for preference in headers.flat_map(|header| header.split(',')) {
        let preference = preference.trim().to_ascii_lowercase();
        let Some(parts) = LANGUAGE_PREFERENCE.captures(&preference) else {
            continue;
        };

        let quality = parts.get(2).map_or(1.0, |value| {
            value.as_str().parse::<f64>().expect("valid weight")
        });
        if quality <= best_quality {
            continue;
        }

        let mut language = &parts[1];
        loop {
            if let Some(path) = languages.get(language) {
                result = path;
                best_quality = quality;
                break;
            }
            let Some((parent, _)) = language.rsplit_once('-') else {
                break;
            };
            language = parent;
        }

        if best_quality == 1.0 {
            break;
        }
    }

    result
}

pub fn encode_path(path: &str) -> String {
    utf8_percent_encode(path, PATH_ESCAPES).to_string()
}

pub fn decode_path(path: &str) -> Option<std::borrow::Cow<'_, str>> {
    if !path.starts_with('/') || path.contains("//") {
        return None;
    }

    for (index, byte) in path.bytes().enumerate() {
        if byte == b'%' {
            let pair = path.as_bytes().get(index + 1..index + 3)?;
            if !pair.iter().all(u8::is_ascii_hexdigit) || pair.eq_ignore_ascii_case(b"2f") {
                return None;
            }
        }
    }

    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if decoded
        .chars()
        .any(|character| character.is_control() || character == '\\')
        || decoded
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return None;
    }

    Some(decoded)
}

pub fn public_path(path: &str) -> bool {
    path.split('/').enumerate().all(|(index, segment)| {
        !segment.starts_with('.') || (index == 1 && segment == ".well-known")
    })
}

pub fn origin_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains(|c: char| c.is_whitespace() || c == '\\')
}

pub fn redirect_target(path: &str) -> bool {
    origin_path(path)
        || (!path.contains('\\')
            && path.parse::<Uri>().is_ok_and(|url| {
                matches!(url.scheme_str(), Some("http" | "https")) && url.authority().is_some()
            }))
}

pub(crate) enum Segment {
    Literal(String),
    Named(String),
    Remainder(String),
}

pub enum Pattern {
    Exact(String),
    Glob(GlobMatcher),
    Segments(Vec<Segment>),
}

impl Pattern {
    pub fn compile(path: &str) -> Result<Self, String> {
        if !origin_path(path) {
            return Err("Invalid path pattern.".into());
        }

        if !path.split('/').any(|part| NAME.is_match(part)) {
            if !path.contains(['*', '?', '[', '{', '!', '+', '@', '(']) {
                return Ok(Self::Exact(path.to_owned()));
            }

            let glob = GlobBuilder::new(path)
                .literal_separator(true)
                .build()
                .map_err(|e| e.to_string())?;
            return Ok(Self::Glob(glob.compile_matcher()));
        }

        let mut names = HashSet::new();
        let mut parts = path.split('/').peekable();
        let mut segments = Vec::new();

        while let Some(part) = parts.next() {
            let Some(capture) = NAME.captures(part) else {
                segments.push(Segment::Literal(part.to_owned()));
                continue;
            };

            let name = capture[1].to_owned();
            let remainder = capture.get(2).is_some();
            if !names.insert(name.clone()) || (remainder && parts.peek().is_some()) {
                return Err("Invalid named path pattern.".into());
            }

            segments.push(if remainder {
                Segment::Remainder(name)
            } else {
                Segment::Named(name)
            });
        }

        Ok(Self::Segments(segments))
    }

    fn capture<'a>(&'a self, path: &'a str) -> Option<Vec<(&'a str, &'a str)>> {
        match self {
            Self::Exact(expected) if expected == path => return Some(Vec::new()),
            Self::Glob(pattern) if pattern.is_match(path) => return Some(Vec::new()),
            Self::Segments(_) => {}
            _ => return None,
        }

        let Self::Segments(pattern) = self else {
            return None;
        };
        let mut remainder = Some(path);
        let mut captures = Vec::new();

        for part in pattern {
            if let Segment::Remainder(name) = part {
                captures.push((name.as_str(), remainder.unwrap_or_default()));
                return Some(captures);
            }

            let rest = remainder?;
            let (segment, rest) = rest
                .split_once('/')
                .map_or((rest, None), |(head, tail)| (head, Some(tail)));
            remainder = rest;

            match part {
                Segment::Literal(expected) if segment == expected => {}
                Segment::Named(name) if !segment.is_empty() => {
                    captures.push((name.as_str(), segment))
                }
                _ => return None,
            }
        }

        remainder.is_none().then_some(captures)
    }

    pub fn matches(&self, path: &str) -> bool {
        self.capture(path).is_some()
    }
}

pub struct Rule {
    source: Pattern,
    destination: String,
    pub status: u16,
}

impl Rule {
    pub fn new(
        source: &str,
        destination: String,
        status: u16,
        redirect: bool,
    ) -> Result<Self, String> {
        let valid = if redirect {
            redirect_target(&destination)
        } else {
            origin_path(&destination)
        };
        if !valid || !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return Err("Invalid route target or status.".into());
        }

        Ok(Self {
            source: Pattern::compile(source)?,
            destination,
            status,
        })
    }

    pub fn apply(&self, path: &str) -> Option<String> {
        let captures = self.source.capture(path)?;
        if captures.is_empty() {
            return Some(self.destination.clone());
        }

        let expanded =
            REFERENCE.replace_all(&self.destination, |reference: &regex::Captures<'_>| {
                captures
                    .iter()
                    .find(|(name, _)| *name == &reference[1])
                    .map_or_else(|| reference[0].to_owned(), |(_, value)| encode_path(value))
            });

        Some(expanded.into_owned())
    }
}

pub fn cli_rule(text: &str, redirect: bool) -> Result<Rule, String> {
    let (source, target) = text
        .split_once('=')
        .ok_or("Expected a route in source=target form.")?;
    if text.contains(char::is_whitespace) {
        return Err("Route rules cannot contain whitespace.".into());
    }

    let (destination, status) = if redirect {
        target
            .rsplit_once('=')
            .filter(|(_, code)| code.len() == 3 && code.bytes().all(|byte| byte.is_ascii_digit()))
            .map_or((target, 302), |(destination, code)| {
                (destination, code.parse().unwrap_or(0))
            })
    } else {
        (target, 302)
    };

    Rule::new(source, destination.to_owned(), status, redirect)
}
