# Fotone

The fastest one-command static web server in the world. ⚡  
One command. All the power.

**Fotone** is built in Rust and runs on Linux x64 and Apple Silicon.

## Usage

```sh
npx fotone ./dist --port 8080 --spa
npx fotone --help
```

## CLI Reference

```text
Usage:
  fotone <root> [options]

Options:
  Option                                   Default  Description
  --host <host>                            0.0.0.0  Bind address
  --port <port>                            0        Bind TCP port (0 lets the OS choose)
  --spa[=<file>]                           off      Enable SPA fallback to index.html
  --langs <tags>                           none     Redirect / by browser language. Use comma-separated tags with the default first.
  --rewrite <pattern>=<replacement>        none     Rewrite matching URLs to local paths (repeatable)
  --redirect <source>=<target>[=<status>]  none     Redirect matching URLs (repeatable, default status: 302)
  -H, --header <name:value>                none     Add a response header (repeatable)
  --auth <user:password|htpasswd>          none     Enable Basic Auth with a password or htpasswd bcrypt record
  --auth-include <path-or-glob>            none     Include Basic Auth only for matching paths (repeatable)
  --auth-exclude <path-or-glob>            none     Exclude Basic Auth for matching paths (repeatable)
  --cors                                   off      Set Access-Control-Allow-Origin
  --coop                                   off      Set Cross-Origin-Opener-Policy
  --coep                                   off      Set Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy
  --pna                                    off      Set Access-Control-Allow-Private-Network
  -i, --immutable                          off      Set Cache-Control: immutable
  -m, --maxage <seconds>                   none     Set Cache-Control: max-age=<seconds>
  -t, --timeout <seconds>                  30       Set idle timeout in seconds (0 disables it)
  --env-json <names>                       none     Expose comma-separated environment variables as JSON at /env
  -q, --quiet                              off      Suppress output and logs
  -c, --config <file>                      none     Load a JSON configuration file
  -h, --help                               off      Show help
  -v, --version                            off      Show version
```

## Development

Full reference and benchmarks are at <https://damianobarbati.github.io/fotone/>.

Setup:

```sh
fnm install
npm install -g corepack
corepack enable
pnpm install
brew install rust
```

```sh
pnpm build
pnpm test
```

Website at `http://localhost:3001` with:

```sh
pnpm -F website dev
```

## Release

Run from the repository root on Apple Silicon with Rust and Docker installed. Keep the root version and the Rust crate version in sync, including `Cargo.lock`.

```sh
pnpm build

mkdir -p packages/fotone-rust/target/x86_64-unknown-linux-musl

docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$PWD/packages/fotone-rust,target=/src,readonly" \
  --mount "type=bind,source=$PWD/packages/fotone-rust/target/x86_64-unknown-linux-musl,target=/out" \
  --workdir /src rust:1.100.0-alpine3.24 \
  cargo build --locked --release --target-dir /out

pnpm pack --dry-run
pnpm publish --access=public
```
