set -eu
dest="${1:?usage: install-cua-driver.sh <bin folder>}"
version=0.38.0
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64; sha256=31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd ;;
  aarch64 | arm64) arch=arm64; sha256=80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if "$dest/cua-driver" --version 2>/dev/null | grep -qx "cua-driver $version"; then exit 0; fi
mkdir -p "$dest"
archive="$(mktemp)"
trap 'rm -f "$archive" "$archive.member"' EXIT
curl -fsSL --retry 5 \
  "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/cua-driver-rs-${version}-linux-${arch}-binary.tar.gz" -o "$archive"
echo "$sha256  $archive" | sha256sum -c -
# The binary release bundles helper members next to the driver; only the driver
# speaks the stdio MCP surface this image uses.
tar -xzf "$archive" -O cua-driver > "$archive.member"
chmod 755 "$archive.member"
"$archive.member" --version | grep -qx "cua-driver $version"
install -m 755 "$archive.member" "$dest/cua-driver"
"$dest/cua-driver" --version
