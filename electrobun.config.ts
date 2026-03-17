const config = {
  app: {
    name: "Chat",
    identifier: "com.chad.app",
  },
  build: {
    mac: {
      icons: "icon.iconset",
      codesign: true,
      notarize: true,
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
    },
  },
};

export default config;
