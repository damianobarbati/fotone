use crate::routing::{
    Pattern, Rule, cli_rule, decode_path, encode_path, is_language_tag, origin_path,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use ipnet::IpNet;
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, env, fs, net::IpAddr, path::PathBuf, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

struct OptionSpec {
    name: &'static str,
    alias: Option<char>,
    value: &'static str,
    default: &'static str,
    description: &'static str,
}

const OPTIONS: &[OptionSpec] = &[
    OptionSpec {
        name: "host",
        alias: None,
        value: "<host>",
        default: "0.0.0.0",
        description: "Bind address",
    },
    OptionSpec {
        name: "port",
        alias: None,
        value: "<port>",
        default: "0",
        description: "Bind TCP port (0 lets the OS choose)",
    },
    OptionSpec {
        name: "spa",
        alias: None,
        value: "[=<file>]",
        default: "off",
        description: "Enable SPA fallback to index.html",
    },
    OptionSpec {
        name: "langs",
        alias: None,
        value: "<tags>",
        default: "none",
        description: "Redirect / by browser language. Use comma-separated tags with the default first.",
    },
    OptionSpec {
        name: "rewrite",
        alias: None,
        value: "<pattern>=<replacement>",
        default: "none",
        description: "Rewrite matching URLs to local paths (repeatable)",
    },
    OptionSpec {
        name: "redirect",
        alias: None,
        value: "<source>=<target>[=<status>]",
        default: "none",
        description: "Redirect matching URLs (repeatable, default status: 302)",
    },
    OptionSpec {
        name: "header",
        alias: Some('H'),
        value: "<name:value>",
        default: "none",
        description: "Add a response header (repeatable)",
    },
    OptionSpec {
        name: "auth",
        alias: None,
        value: "<user:password|htpasswd>",
        default: "none",
        description: "Enable Basic Auth with a password or htpasswd bcrypt record",
    },
    OptionSpec {
        name: "auth-include",
        alias: None,
        value: "<path-or-glob>",
        default: "none",
        description: "Include Basic Auth only for matching paths (repeatable)",
    },
    OptionSpec {
        name: "auth-exclude",
        alias: None,
        value: "<path-or-glob>",
        default: "none",
        description: "Exclude Basic Auth for matching paths (repeatable)",
    },
    OptionSpec {
        name: "cors",
        alias: None,
        value: "",
        default: "off",
        description: "Set Access-Control-Allow-Origin",
    },
    OptionSpec {
        name: "coop",
        alias: None,
        value: "",
        default: "off",
        description: "Set Cross-Origin-Opener-Policy",
    },
    OptionSpec {
        name: "coep",
        alias: None,
        value: "",
        default: "off",
        description: "Set Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy",
    },
    OptionSpec {
        name: "pna",
        alias: None,
        value: "",
        default: "off",
        description: "Set Access-Control-Allow-Private-Network",
    },
    OptionSpec {
        name: "immutable",
        alias: Some('i'),
        value: "",
        default: "off",
        description: "Set Cache-Control: immutable",
    },
    OptionSpec {
        name: "maxage",
        alias: Some('m'),
        value: "<seconds>",
        default: "none",
        description: "Set Cache-Control: max-age=<seconds>",
    },
    OptionSpec {
        name: "timeout",
        alias: Some('t'),
        value: "<seconds>",
        default: "30",
        description: "Set idle timeout in seconds (0 disables it)",
    },
    OptionSpec {
        name: "env-json",
        alias: None,
        value: "<names>",
        default: "none",
        description: "Expose comma-separated environment variables as JSON at /env",
    },
    OptionSpec {
        name: "quiet",
        alias: Some('q'),
        value: "",
        default: "off",
        description: "Suppress output and logs",
    },
    OptionSpec {
        name: "config",
        alias: Some('c'),
        value: "<file>",
        default: "none",
        description: "Load a JSON configuration file",
    },
    OptionSpec {
        name: "help",
        alias: Some('h'),
        value: "",
        default: "off",
        description: "Show help",
    },
    OptionSpec {
        name: "version",
        alias: Some('v'),
        value: "",
        default: "off",
        description: "Show version",
    },
];

#[derive(Default)]
pub struct Options {
    values: HashMap<&'static str, Vec<String>>,
    roots: Vec<PathBuf>,
}

impl Options {
    pub fn parse(arguments: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut result = Self::default();
        let mut args = arguments.peekable();

        while let Some(arg) = args.next() {
            if arg == "--" {
                result.roots.extend(args.map(PathBuf::from));
                break;
            }

            if let Some(long) = arg.strip_prefix("--") {
                let (name, attached) = long
                    .split_once('=')
                    .map_or((long, None), |(key, value)| (key, Some(value)));
                let option = OPTIONS
                    .iter()
                    .find(|item| item.name == name)
                    .ok_or("Unknown option.")?;
                result.add(option, attached, &mut args)?;
            } else if arg.starts_with('-') && arg != "-" {
                let mut short = arg[1..].chars();

                while let Some(alias) = short.next() {
                    let option = OPTIONS
                        .iter()
                        .find(|item| item.alias == Some(alias))
                        .ok_or("Unknown short option.")?;
                    let attached = (!option.value.is_empty() && !short.as_str().is_empty())
                        .then_some(short.as_str());
                    result.add(option, attached, &mut args)?;

                    if !option.value.is_empty() {
                        break;
                    }
                }
            } else {
                result.roots.push(arg.into());
            }
        }

        Ok(result)
    }

    fn add(
        &mut self,
        option: &OptionSpec,
        attached: Option<&str>,
        args: &mut std::iter::Peekable<impl Iterator<Item = String>>,
    ) -> Result<(), String> {
        let value = match (option.name, option.value, attached) {
            ("spa", _, None) => "index.html".into(),
            (_, "", None) => String::new(),
            (_, "", Some(_)) => return Err(format!("--{} does not accept a value.", option.name)),
            (_, _, Some(value)) => value.to_owned(),
            _ if args.peek().is_some_and(|value| value.starts_with('-')) => {
                return Err(format!("--{} requires a value.", option.name));
            }
            _ => args
                .next()
                .ok_or_else(|| format!("--{} requires a value.", option.name))?,
        };

        self.values.entry(option.name).or_default().push(value);
        Ok(())
    }

    pub fn help() {
        let rows: Vec<_> = OPTIONS
            .iter()
            .map(|option| {
                let alias = option
                    .alias
                    .map_or_else(String::new, |short| format!("-{short}, "));
                let space = if option.value.is_empty() || option.value.starts_with('[') {
                    ""
                } else {
                    " "
                };
                (
                    format!("{alias}--{}{space}{}", option.name, option.value),
                    option.default,
                    option.description,
                )
            })
            .collect();
        let width = rows
            .iter()
            .map(|(label, _, _)| label.len())
            .max()
            .unwrap_or(6);
        println!(
            "Usage:\n  fotone <root> [options]\n\nOptions:\n  {:width$}  {:<7}  Description",
            "Option", "Default"
        );

        for (label, default, description) in rows {
            println!("  {label:width$}  {default:<7}  {description}");
        }
    }

    pub fn flag(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.values
            .get(name)
            .and_then(|values| values.last())
            .map(String::as_str)
    }

    fn list(&self, name: &str) -> &[String] {
        self.values.get(name).map_or(&[], Vec::as_slice)
    }
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct JsonConfig {
    base_path: String,
    trusted_proxies: Vec<String>,
    extension_fallback: bool,
    clean_urls: bool,
    strip_trailing_slash: bool,
    spa_excludes: Vec<String>,
    headers: Vec<JsonHeaders>,
    rewrites: Vec<JsonRewrite>,
    redirects: Vec<JsonRedirect>,
    language_redirect: Option<LanguageRedirect>,
}

impl Default for JsonConfig {
    fn default() -> Self {
        Self {
            base_path: "/".into(),
            trusted_proxies: Vec::new(),
            extension_fallback: true,
            clean_urls: true,
            strip_trailing_slash: true,
            spa_excludes: Vec::new(),
            headers: Vec::new(),
            rewrites: Vec::new(),
            redirects: Vec::new(),
            language_redirect: None,
        }
    }
}

#[derive(Deserialize)]
struct JsonHeaders {
    paths: Vec<String>,
    #[serde(flatten)]
    headers: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonRewrite {
    source: String,
    destination: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JsonRedirect {
    source: String,
    destination: String,
    #[serde(default = "temporary_redirect")]
    status: u16,
}

fn temporary_redirect() -> u16 {
    302
}

pub type Headers = Vec<(HeaderName, Option<HeaderValue>)>;
#[derive(Deserialize)]
pub struct LanguageRedirect {
    pub default: String,
    #[serde(flatten)]
    pub languages: HashMap<String, String>,
}

impl LanguageRedirect {
    fn from_cli(value: &str, base_path: &str) -> Result<Self, String> {
        let tags: Vec<_> = value
            .split(',')
            .map(|tag| tag.trim().to_ascii_lowercase())
            .collect();
        if tags.iter().any(|tag| !is_language_tag(tag)) {
            return Err("--langs requires comma-separated language tags.".into());
        }

        let prefix = encode_path(base_path.trim_end_matches('/'));
        let default = format!("{prefix}/{}", tags[0]);
        let languages = tags
            .into_iter()
            .map(|tag| {
                let path = format!("{prefix}/{tag}");
                (tag, path)
            })
            .collect();
        Ok(Self { default, languages })
    }
}

fn language_redirect_path(path: &str) -> bool {
    path != "/"
        && path.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        && !path.contains(['?', '#'])
        && origin_path(path)
        && decode_path(path).is_some()
}

type HeaderRule = (Vec<Pattern>, Headers);

pub struct Config {
    pub directory: PathBuf,
    pub host: String,
    pub port: u16,
    pub timeout: Duration,
    pub quiet: bool,
    pub auth: Option<Auth>,
    pub env_json: Option<Bytes>,
    pub language_redirect: Option<LanguageRedirect>,
    pub spa: Option<String>,
    pub spa_excludes: Vec<Pattern>,
    pub trusted: Vec<IpNet>,
    pub redirects: Vec<Rule>,
    pub rewrites: Vec<Rule>,
    pub headers: Headers,
    pub header_rules: Vec<HeaderRule>,
    pub base_path: String,
    pub extension_fallback: bool,
    pub clean_urls: bool,
    pub strip_trailing_slash: bool,
    pub cors: bool,
    pub cache_control: HeaderValue,
}

fn decimal(value: &str, max: u64) -> Result<u64, String> {
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Expected a nonnegative integer.".into());
    }

    let number = value.parse::<u64>().map_err(|_| "Invalid integer.")?;
    if number > max {
        return Err("Integer exceeds supported range.".into());
    }

    Ok(number)
}

fn host(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.contains(|c: char| c.is_whitespace() || c.is_control()) {
        return Err("Invalid host.".into());
    }

    Ok(value)
}

fn compile_patterns(values: &[String]) -> Result<Vec<Pattern>, String> {
    values.iter().map(|value| Pattern::compile(value)).collect()
}

fn header(name: &str, value: Option<&str>) -> Result<(HeaderName, Option<HeaderValue>), String> {
    let name: HeaderName = name.parse().map_err(|_| "Invalid header name.")?;

    if matches!(
        name.as_str(),
        "connection"
            | "content-encoding"
            | "content-length"
            | "keep-alive"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    ) {
        return Err(format!("Header {name} is controlled by the server."));
    }

    let value = value
        .map(str::parse)
        .transpose()
        .map_err(|_| "Invalid header value.")?;
    Ok((name, value))
}

fn env_vars() -> Result<HashMap<String, String>, String> {
    let mut values = HashMap::new();

    match dotenvy::from_path_iter(".env") {
        Ok(file) => {
            for entry in file {
                let (name, value) = entry.map_err(|_| "Invalid .env file.")?;
                values.insert(name, value);
            }
        }
        Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not read .env file.".into()),
    }

    values.extend(env::vars());
    Ok(values)
}

impl Config {
    pub fn load(options: &Options) -> Result<Self, String> {
        let [root] = options.roots.as_slice() else {
            return Err("Specify one static root directory.".into());
        };

        let directory = root
            .canonicalize()
            .map_err(|error| format!("Cannot resolve static root: {error}"))?;
        if !directory.is_dir() {
            return Err("Static root must be a directory.".into());
        }

        let json: JsonConfig = match options.get("config") {
            Some(path) => {
                let content = fs::read(path)
                    .map_err(|error| format!("Cannot read configuration: {error}"))?;
                serde_json::from_slice(&content)
                    .map_err(|error| format!("Invalid JSON configuration: {error}"))?
            }
            None => JsonConfig::default(),
        };

        if decode_path(&json.base_path).is_none()
            || (json.base_path.len() > 1 && json.base_path.ends_with('/'))
        {
            return Err("Invalid base path.".into());
        }

        if let Some(redirect) = &json.language_redirect
            && (!language_redirect_path(&redirect.default)
                || redirect.languages.iter().any(|(language, path)| {
                    !is_language_tag(language) || !language_redirect_path(path)
                }))
        {
            return Err("Invalid language redirect.".into());
        }

        let vars = env_vars()?;
        let env_host = vars.get("HOST").map(|value| host(value)).transpose()?;
        let bind_host = options
            .get("host")
            .map(host)
            .transpose()?
            .or(env_host)
            .unwrap_or("0.0.0.0");
        let env_port = vars
            .get("PORT")
            .map(|value| decimal(value, u16::MAX.into()))
            .transpose()?;
        let port = options
            .get("port")
            .map(|value| decimal(value, u16::MAX.into()))
            .transpose()?
            .or(env_port)
            .unwrap_or(0);
        let timeout = decimal(options.get("timeout").unwrap_or("30"), 2_147_483)?;
        let auth = Auth::new(options)?;

        let mut cache = options
            .get("maxage")
            .map(|value| {
                let max_age = decimal(value, 2_147_483_647)?;
                let scope = if auth.is_some() { "private" } else { "public" };
                Ok::<_, String>(format!("{scope}, max-age={max_age}"))
            })
            .transpose()?
            .unwrap_or_else(|| "no-cache".into());
        if options.flag("immutable") {
            cache.push_str(", immutable");
        }

        let spa = options
            .get("spa")
            .map(|value| {
                let path = format!("/{}", value.strip_prefix('/').unwrap_or(value));
                decode_path(&path)
                    .filter(|decoded| decoded != "/")
                    .map(|value| value.into_owned())
                    .ok_or("--spa requires a local fallback file.")
            })
            .transpose()?;

        let env_json = options
            .get("env-json")
            .map(|names| {
                let valid = Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").expect("literal regex");
                let mut exported = serde_json::Map::new();

                for name in names.split(',').map(str::trim) {
                    if !valid.is_match(name) {
                        return Err("--env-json requires valid variable names.".to_owned());
                    }

                    let value = vars
                        .get(name)
                        .ok_or_else(|| format!("Missing environment variable: {name}."))?;
                    exported.insert(name.to_owned(), value.clone().into());
                }

                serde_json::to_vec(&exported)
                    .map(Bytes::from)
                    .map_err(|error| error.to_string())
            })
            .transpose()?;

        let mut rewrites = options
            .list("rewrite")
            .iter()
            .map(|rule| cli_rule(rule, false))
            .collect::<Result<Vec<_>, _>>()?;

        for rule in json.rewrites {
            rewrites.push(Rule::new(&rule.source, rule.destination, 302, false)?);
        }

        let mut redirects = options
            .list("redirect")
            .iter()
            .map(|rule| cli_rule(rule, true))
            .collect::<Result<Vec<_>, _>>()?;

        for rule in json.redirects {
            redirects.push(Rule::new(
                &rule.source,
                rule.destination,
                rule.status,
                true,
            )?);
        }

        let trusted = json
            .trusted_proxies
            .iter()
            .map(|text| {
                text.parse::<IpNet>()
                    .or_else(|_| text.parse::<IpAddr>().map(IpNet::from))
                    .map_err(|_| "Invalid trusted proxy address.")
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut headers = Vec::new();

        for (enabled, name, value) in [
            (options.flag("cors"), "access-control-allow-origin", "*"),
            (
                options.flag("coop") || options.flag("coep"),
                "cross-origin-opener-policy",
                "same-origin",
            ),
            (
                options.flag("coep"),
                "cross-origin-embedder-policy",
                "require-corp",
            ),
            (
                options.flag("pna"),
                "access-control-allow-private-network",
                "true",
            ),
        ] {
            if enabled {
                headers.push(header(name, Some(value))?);
            }
        }

        for raw in options.list("header") {
            let (name, value) = raw.split_once(':').ok_or("--header requires name:value.")?;
            headers.push(header(name.trim(), Some(value.trim()))?);
        }

        let header_rules = json
            .headers
            .into_iter()
            .map(|rule| {
                if rule.paths.is_empty() {
                    return Err("Header paths cannot be empty.".into());
                }

                let values = rule
                    .headers
                    .iter()
                    .map(|(name, value)| match value {
                        serde_json::Value::Null => header(name, None),
                        serde_json::Value::String(value) => header(name, Some(value)),
                        _ => Err("Header values must be strings or null.".into()),
                    })
                    .collect::<Result<Headers, String>>()?;

                Ok((compile_patterns(&rule.paths)?, values))
            })
            .collect::<Result<Vec<HeaderRule>, String>>()?;

        Ok(Self {
            directory,
            host: bind_host.to_owned(),
            port: port as u16,
            timeout: Duration::from_secs(timeout),
            quiet: options.flag("quiet"),
            auth,
            env_json,
            language_redirect: match options.get("langs") {
                Some(value) => Some(LanguageRedirect::from_cli(value, &json.base_path)?),
                None => json.language_redirect,
            },
            spa,
            spa_excludes: compile_patterns(&json.spa_excludes)?,
            trusted,
            redirects,
            rewrites,
            headers,
            header_rules,
            base_path: json.base_path,
            extension_fallback: json.extension_fallback,
            clean_urls: json.clean_urls,
            strip_trailing_slash: json.strip_trailing_slash,
            cors: options.flag("cors"),
            cache_control: HeaderValue::from_str(&cache).map_err(|error| error.to_string())?,
        })
    }

    pub fn client_address(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        let normalize = |address: IpAddr| address.to_canonical();
        let peer = normalize(peer);
        let trusted = |address| {
            self.trusted
                .iter()
                .any(|network| network.contains(&address))
        };
        if !trusted(peer) {
            return peer;
        }

        let mut chain = Vec::new();

        for header in headers.get_all("x-forwarded-for") {
            let Ok(value) = header.to_str() else {
                return peer;
            };

            for field in value.split(',') {
                let Ok(address) = field.trim().parse() else {
                    return peer;
                };
                chain.push(normalize(address));
            }
        }

        chain
            .iter()
            .rev()
            .copied()
            .find(|address| !trusted(*address))
            .or_else(|| chain.first().copied())
            .unwrap_or(peer)
    }
}

enum Password {
    Plain([u8; 32]),
    Hash(String),
}

pub struct Auth {
    username: [u8; 32],
    password: Password,
    includes: Vec<Pattern>,
    excludes: Vec<Pattern>,
    comparisons: Arc<Semaphore>,
}

fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

impl Auth {
    fn new(options: &Options) -> Result<Option<Self>, String> {
        let includes = compile_patterns(options.list("auth-include"))?;
        let excludes = compile_patterns(options.list("auth-exclude"))?;
        let Some(raw) = options.get("auth") else {
            return Ok(None);
        };
        let (username, password) = raw
            .split_once(':')
            .filter(|(user, pass)| !user.is_empty() && !pass.is_empty())
            .ok_or("--auth requires a username and password or bcrypt hash.")?;

        let password = if let Some(hash) = password.strip_prefix("$2y$") {
            let valid = Regex::new(r"^(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$")
                .expect("literal regex");
            if !valid.is_match(hash) {
                return Err("Invalid htpasswd bcrypt hash.".into());
            }
            Password::Hash(format!("$2b${hash}"))
        } else {
            Password::Plain(digest(password))
        };

        Ok(Some(Self {
            username: digest(username),
            password,
            includes,
            excludes,
            comparisons: Arc::new(Semaphore::new(4)),
        }))
    }

    pub async fn allows(&self, path: &str, header: Option<&HeaderValue>) -> bool {
        if (!self.includes.is_empty() && !self.includes.iter().any(|pattern| pattern.matches(path)))
            || self.excludes.iter().any(|pattern| pattern.matches(path))
        {
            return true;
        }

        let Some(header) = header.and_then(|value| value.to_str().ok()) else {
            return false;
        };
        let Some((scheme, encoded)) = header.split_once(' ') else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case("basic") {
            return false;
        }

        let Ok(decoded) = STANDARD
            .decode(encoded)
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(encoded))
        else {
            return false;
        };
        let Ok(credentials) = std::str::from_utf8(&decoded) else {
            return false;
        };
        let Some((username, password)) = credentials.split_once(':') else {
            return false;
        };
        if !bool::from(self.username.ct_eq(&digest(username))) {
            return false;
        }

        match &self.password {
            Password::Plain(expected) => expected.ct_eq(&digest(password)).into(),
            Password::Hash(hash) => {
                if password.len() > 72 {
                    return false;
                }

                let Ok(permit) = self.comparisons.clone().try_acquire_owned() else {
                    return false;
                };
                let password = password.to_owned();
                let hash = hash.clone();

                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    bcrypt::verify(password, &hash).unwrap_or(false)
                })
                .await
                .unwrap_or(false)
            }
        }
    }
}
