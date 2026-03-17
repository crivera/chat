const config = {
  app: {
    name: "Chat",
    identifier: "com.chad.app",
  },
  release: {
    baseUrl: "https://github.com/crivera/chat/releases/latest/download",
  },
  build: {
    mac: {
      icons: "icon.iconset",
      codesign: true,
      notarize: true,
    },
    win: {
      icon: "icon.ico",
    },
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.ts",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
      "node_modules/@xterm/xterm/css/xterm.css": "views/mainview/xterm.css",
      "node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.dylib":
        "bun/rust-pty/target/release/librust_pty_arm64.dylib",
      "node_modules/bun-pty/rust-pty/target/release/librust_pty.dylib":
        "bun/rust-pty/target/release/librust_pty.dylib",
      "node_modules/bun-pty/rust-pty/target/release/librust_pty_arm64.so":
        "bun/rust-pty/target/release/librust_pty_arm64.so",
      "node_modules/bun-pty/rust-pty/target/release/librust_pty.so":
        "bun/rust-pty/target/release/librust_pty.so",
      "node_modules/bun-pty/rust-pty/target/release/rust_pty.dll":
        "bun/rust-pty/target/release/rust_pty.dll",
    },
  },
};

export default config;
