"use strict";
//Starts with: npm start

import {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  ipcMain,
  Menu,
  nativeTheme,
  dialog,
} from "electron";
import path from "path";
let win;
let MenuTemp;
let PreloadPath = path.join(app.getAppPath(), "/renderer/preload.js");

const CreateWindow = () => {
  win = new BrowserWindow({
    width: 800,
    height: 550,
    x: 490,
    y: 0,
    title: "Reroll",

    webPreferences: {
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      preload: PreloadPath,
      contentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self';",
    },
  });

  win.loadFile("renderer/index.html");
};

app.whenReady().then(() => {
  CreateWindow();
  MenuTemp = [
    { label: "Reload", accelerator: "Ctrl+R", role: "forceReload" },
    {
      label: "Dev tools",
      role: "toggleDevTools",
      accelerator: "Ctrl+`",
    },
  ];
  const menu = Menu.buildFromTemplate(MenuTemp);
  Menu.setApplicationMenu(menu);
});
