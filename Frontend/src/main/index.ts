import { app, shell, BrowserWindow, ipcMain, nativeImage, nativeTheme } from "electron";
import { existsSync } from "fs";
import { join } from "path";
import { registerGithubHandlers } from "./github";
import { registerWorkspaceHandlers } from "./workspace";
import { registerBrowserAgentHandlers } from "./browserAgent";
import { registerAgentHandlers } from "./agent";
import { registerTerminalHandlers } from "./terminal";
import { registerGitHandlers } from "./git";

if (process.env["ELECTRON_RENDERER_URL"]) {
  // Dev-only: expose the Chrome DevTools Protocol for automation/verification.
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
}

if (process.platform === "win32") {
  // Stable taskbar grouping so the window shows the Xvie icon, not Electron's.
  app.setAppUserModelId("com.xvie.app");
}

type ThemeMode = "light" | "dark";

const THEME_BACKGROUND: Record<ThemeMode, string> = {
  light: "#F5F5F5",
  dark: "#000000"
};

/** Resolve a branded window icon, preferring the theme-matching set. */
function resolveAppIcon(mode: ThemeMode): string | undefined {
  const names =
    process.platform === "win32"
      ? [`icon-${mode}.ico`, "icon-dark.ico", "icon-light.ico"]
      : process.platform === "darwin"
        ? [`icon-${mode}.icns`, "icon-dark.icns", "icon-light.icns"]
        : [`icon-${mode}.png`, "icon-dark.png", "icon-light.png"];
  // Dev (electron-vite): app path is the Frontend package root.
  // Packaged: check process.resourcesPath (+ resources subfolder).
  const bases = [
    join(app.getAppPath(), "resources"),
    join(process.resourcesPath, "resources"),
    process.resourcesPath,
    join(__dirname, "../../resources")
  ];
  for (const base of bases) {
    for (const name of names) {
      const candidate = join(base, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Apply the OS chrome (title bar, taskbar icon) for the given app theme. */
function applyNativeTheme(mode: ThemeMode): void {
  // Dark themeSource opts the native frame into Windows immersive dark mode,
  // so the minimize/maximize/close bar follows the app instead of staying white.
  nativeTheme.themeSource = mode;
  const background = THEME_BACKGROUND[mode];
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.setBackgroundColor(background);
      const iconPath = resolveAppIcon(mode);
      if (iconPath) window.setIcon(nativeImage.createFromPath(iconPath));
    } catch {
      // Best-effort: a missing icon or closed window must never break startup.
    }
  }
}

function registerThemeHandlers(): void {
  ipcMain.handle("app:set-theme", (_event, mode: ThemeMode) => {
    if (mode !== "light" && mode !== "dark") return { success: false };
    applyNativeTheme(mode);
    return { success: true };
  });
}

function createWindow(): void {
  // Default to dark chrome before first paint; the renderer reports its real
  // saved theme at boot and this is corrected immediately after.
  nativeTheme.themeSource = "dark";
  const mainWindow = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 480,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "Xvie",
    backgroundColor: THEME_BACKGROUND.dark,
    icon: resolveAppIcon("dark"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false
    }
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerGithubHandlers();
  registerWorkspaceHandlers();
  registerBrowserAgentHandlers();
  registerAgentHandlers();
  registerTerminalHandlers();
  registerGitHandlers();
  registerThemeHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
