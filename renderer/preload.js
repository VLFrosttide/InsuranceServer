const { ipcRenderer, contextBridge } = require("electron");
//Example window.api.GlobalKey((event, data) => {})
// Or window.api.GlobalKey()

contextBridge.exposeInMainWorld("api", {});
