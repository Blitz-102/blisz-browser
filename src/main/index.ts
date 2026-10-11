import { join } from 'node:path';
import { app, BaseWindow, Menu, WebContentsView } from 'electron';

// Temporary caption buttons; the real window-controls decision is in Phase 1 (PLAN 4.6).
// Keep in sync with src/ui/styles/tokens.css (--color-frame, --color-text, --titlebar-height).
const FRAME_COLOR = '#d9e3dc';
const SYMBOL_COLOR = '#1f2a26';
const TITLE_BAR_HEIGHT = 40;

Menu.setApplicationMenu(null);

function createWindow(): void {
  const window = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    backgroundColor: FRAME_COLOR,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: FRAME_COLOR, symbolColor: SYMBOL_COLOR, height: TITLE_BAR_HEIGHT },
  });

  const uiView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/ui.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  uiView.setBackgroundColor(FRAME_COLOR);
  window.contentView.addChildView(uiView);

  // getContentBounds() is in screen coordinates; the view needs window-relative ones.
  const fitUiView = () => {
    const { width, height } = window.getContentBounds();
    uiView.setBounds({ x: 0, y: 0, width, height });
  };
  window.on('resize', fitUiView);
  fitUiView();

  // Show the window even if the UI fails to load, so it is never left invisible.
  uiView.webContents.once('did-stop-loading', () => window.show());

  // WebContentsView contents are not destroyed with the window.
  window.on('closed', () => uiView.webContents.close());

  // Dev only: the app menu is removed, so provide DevTools shortcuts here.
  if (!app.isPackaged) {
    uiView.webContents.on('before-input-event', (event, input) => {
      const isDevToolsKey =
        input.type === 'keyDown' &&
        (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'));
      if (isDevToolsKey) {
        event.preventDefault();
        uiView.webContents.toggleDevTools();
      }
    });
  }

  // Only the dev server may supply a URL; a packaged build always loads its bundled UI.
  const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    uiView.webContents.loadURL(devUrl);
  } else {
    uiView.webContents.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
