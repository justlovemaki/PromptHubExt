import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, screen, shell, dialog } from 'electron';
import * as path from 'path';
import { keyboard, Key, mouse, Button } from '@nut-tree/nut-js';
import Store from 'electron-store';
import fetch from 'node-fetch';
import { getCurrentLanguageBaseUrl } from '../renderer/src/config';
import { initI18n, t, getCurrentLanguage, SUPPORTED_LANGUAGES } from './i18n';

// 简单的日志记录器
const writeLog = (message: string, level: string = 'INFO') => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
};

const clearLog = () => {
  console.log('Log cleared');
};

const getLogFilePath = (): string => {
  return path.join(app.getPath('userData'), 'desktop-app.log');
};

// 快捷键配置类型
interface ShortcutConfig {
  id: string;
  name: string;
  key: string;
  description: string;
  defaultKey: string;
  action: string;
}

// 快捷键配置映射类型
interface ShortcutsConfig {
  [key: string]: ShortcutConfig;
}

// 用户快捷键设置类型
interface UserShortcutSettings {
  shortcuts: {
    [action: string]: string;
  };
}

// 默认快捷键配置
const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  openPanel: {
    id: 'openPanel',
    name: '打开面板',
    key: 'openPanel',
    description: '打开/关闭命令面板',
    defaultKey: process.platform === 'darwin' ? 'Cmd+Alt+O' : 'Ctrl+Alt+O',
    action: 'openPanel'
  },
  quickSaveSelection: {
    id: 'quickSaveSelection',
    name: '快速保存选中文案',
    key: 'quickSaveSelection',
    description: '快速保存选中的文本为提示词',
    defaultKey: process.platform === 'darwin' ? 'Cmd+Alt+P' : 'Ctrl+Alt+P',
    action: 'quickSaveSelection'
  },
  checkCommand: {
    id: 'checkCommand',
    name: '检测命令',
    key: 'checkCommand',
    description: '检测输入框中的 /p<number> 命令',
    defaultKey: process.platform === 'darwin' ? 'Cmd+Alt+/' : 'Ctrl+Alt+/',
    action: 'checkCommand'
  }
};

// 获取资源路径
function getResourcePath(relativePath: string): string {
  if (!app.isPackaged) {
    writeLog(`Resource path dev: ${path.join(__dirname, '../../resources', relativePath)}`);
    return path.join(__dirname, '../../resources', relativePath);
  }
  writeLog(`Resource path prod  : ${path.join(process.resourcesPath, relativePath)}`);
  return path.join(process.resourcesPath, relativePath);
}

let tray: any;
let commandPaletteWindow: any;
let lastMousePosition: { x: number; y: number } | null = null;
const width= 460;
const height = 1080;

// 创建系统托盘
function createTray() {
  try {
    // 初始化多语言
    initI18n();
    
    const iconPath = getResourcePath('icon.png');
    writeLog(`Tray icon path: ${iconPath}`);
    
    tray = new Tray(iconPath);
    writeLog('Tray created successfully');
  } catch (error: any) {
    writeLog(`Failed to create tray: ${error.message}`, 'ERROR');
    throw error;
  }

  // 创建托盘上下文菜单
  updateTrayMenu();
}

// 更新托盘菜单的函数
async function updateTrayMenu() {
  // 从store获取最新的语言设置
  const store = new Store();
  const savedLanguage = store.get('language') as string | undefined;
  writeLog(`Saved language: ${savedLanguage}`);
  
  // 如果store中有语言设置且是支持的语言，则更新当前语言
  if (savedLanguage && SUPPORTED_LANGUAGES.includes(savedLanguage as any)) {
    await initI18n(savedLanguage as any);
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('openPanel'),
      click: () => {
        // 显示命令面板窗口
        const mousePos = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(mousePos);

        // 计算窗口位置（屏幕中央）
        const x = Math.floor(display.bounds.x + (display.bounds.width - width) / 2);
        const y = Math.floor(display.bounds.y + (display.bounds.height - height) / 2);

        commandPaletteWindow.setPosition(x, y);
        commandPaletteWindow.setSize(width, height);

        // 显示并聚焦命令面板
        commandPaletteWindow.show();
        commandPaletteWindow.focus();
      }
    },
    {
      label: t('settings'),
      click: () => {
        // 打开Web端用户设置页面
        const currentLang = getCurrentLanguage();
        const baseUrl = getCurrentLanguageBaseUrl(currentLang);
        shell.openExternal(baseUrl + '/account');
      }
    },
    {
      label: t('quit'),
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(t('appName'));
}

// 创建隐藏的命令面板窗口
function createCommandPaletteWindow() {
  try {
    writeLog('Creating BrowserWindow...');
    
    const iconPath = getResourcePath('icon.png');
    const preloadPath = path.join(__dirname, '../preload/index.js');
    
    writeLog(`Window icon path: ${iconPath}`);
    writeLog(`Preload script path: ${preloadPath}`);
    
    commandPaletteWindow = new BrowserWindow({
    width: width,
    height: height,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
      icon: iconPath,
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
      }
    });

    writeLog('BrowserWindow created');
  } catch (error: any) {
    writeLog(`Failed to create BrowserWindow: ${error.message}`, 'ERROR');
    throw error;
  }

  // 禁用 DevTools 中的 Autofill 警告
  commandPaletteWindow.webContents.on('devtools-opened', () => {
    commandPaletteWindow.webContents.devToolsWebContents?.executeJavaScript(`
      console.warn = (function(originalWarn) {
        return function(...args) {
          const msg = args[0] || '';
          if (typeof msg === 'string' && msg.includes('Autofill')) {
            return;
          }
          originalWarn.apply(console, args);
        };
      })(console.warn);
    `).catch(() => {});
  });

  // 加载命令面板UI
  try {
    if (process.env.NODE_ENV === 'development') {
      writeLog('Loading dev URL...');
      commandPaletteWindow.loadURL('http://localhost:5173');
      commandPaletteWindow.webContents.openDevTools();
    } else {
      const htmlPath = path.join(__dirname, '../renderer/index.html');
      writeLog(`Loading production HTML: ${htmlPath}`);
      commandPaletteWindow.loadFile(htmlPath);
    }
    
    writeLog('UI loaded successfully');
  } catch (error: any) {
    writeLog(`Failed to load UI: ${error.message}`, 'ERROR');
    throw error;
  }

  // 当窗口获得焦点时保存鼠标位置（从其他窗口切换过来时）
  commandPaletteWindow.on('focus', async () => {
    // if (!lastMousePosition) {
      try {
        const currentMousePos = await mouse.getPosition();
        lastMousePosition = { x: currentMousePos.x, y: currentMousePos.y };
        console.log('[Main] 窗口聚焦时已保存鼠标位置:', lastMousePosition);
      } catch (error) {
        console.error('[Main] 获取鼠标位置失败:', error);
      }
    // }
  });

  // 当窗口失去焦点时自动隐藏
  commandPaletteWindow.on('blur', () => {
    commandPaletteWindow.hide();
  });
}

// 获取系统选中的文本
async function getSelectedText(): Promise<string | null> {
  try {
    // 保存当前剪贴板内容
    const originalClipboard = clipboard.readText();
    
    // 模拟复制操作 (Ctrl/Cmd+C) 来获取选中文本
    const keyToPress = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(keyToPress);
    await keyboard.pressKey(Key.C);
    await keyboard.releaseKey(Key.C);
    await keyboard.releaseKey(keyToPress);
    
    // 等待剪贴板更新，使用更可靠的方案
    let attempts = 0;
    const maxAttempts = 10;
    let selectedText = '';
    
    // 循环等待剪贴板内容变化
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 200));
      selectedText = clipboard.readText();
      
      // 如果剪贴板内容发生变化且不为空，认为是新复制的内容
      if (selectedText !== originalClipboard && selectedText.trim()) {
        break;
      }
      
      attempts++;
    }
    
    // 恢复原始剪贴板内容
    clipboard.writeText(originalClipboard);
    
    return selectedText && selectedText.trim() ? selectedText.trim() : null;
  } catch (error) {
    console.error('[Main] 获取选中文本失败:', error);
    return null;
  }
}

// 快速保存选中文案为提示词
async function quickImportPrompt(content: string): Promise<boolean> {
  const store = new Store();
  const authToken = store.get('authToken') as string | undefined;
  
  if (!authToken) {
    console.error('[Main] 未找到认证Token');
    // 通知渲染进程显示错误
    if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) {
      commandPaletteWindow.webContents.send('quick-save-result', {
        success: false,
        error: 'authenticationRequired'
      });
    }
    return false;
  }

  try {
    // const currentLang = getCurrentLanguage();
    const baseUrl = getCurrentLanguageBaseUrl('en');
    
    const response = await fetch(`${baseUrl}/api/prompts/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token ${authToken}`
      },
      body: JSON.stringify({
        title: 'Quickly: ' + content.substring(0, 15),
        content: content,
        description: 'Quickly imported from system selection'
      })
    });

    const result = await response.json() as { success: boolean; data?: any; error?: any };
    
    if (response.ok && result.success) {
      console.log('[Main] 提示词导入成功:', result);
      
      // 通知渲染进程保存成功
      if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) {
        commandPaletteWindow.webContents.send('quick-save-result', {
          success: true
        });
      }
      
      return true;
    } else {
      console.error('[Main] 提示词导入失败:', result);
      
      // 通知渲染进程显示错误
      if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) {
        commandPaletteWindow.webContents.send('quick-save-result', {
          success: false,
          error: 'saveFailed'
        });
      }
      
      return false;
    }
  } catch (error: any) {
    console.error('[Main] 快速导入提示词失败:', error);
    
    // 通知渲染进程显示错误
    if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) {
      commandPaletteWindow.webContents.send('quick-save-result', {
        success: false,
        error: error.message
      });
    }
    
    return false;
  }
}

// 处理快速保存选中文案的快捷键
async function handleQuickSaveSelection(): Promise<void> {
  console.log('[Main] 快速保存选中文案快捷键触发');
  
  try {
    // 获取选中的文本
    const selectedText = await getSelectedText();
    
    if (!selectedText) {
      console.log('[Main] 未选中任何文字');
      
      // 通知渲染进程显示错误
      if (commandPaletteWindow && !commandPaletteWindow.isDestroyed()) {
        commandPaletteWindow.webContents.send('quick-save-result', {
          success: false,
          error: 'noTextSelected'
        });
      }
      
      return;
    }
    
    console.log('[Main] 获取到选中文字:', selectedText.substring(0, 50) + '...');
    
    // 保存为提示词
    await quickImportPrompt(selectedText);
  } catch (error) {
    console.error('[Main] 处理快速保存失败:', error);
  }
}

// 获取当前输入框的全部内容
async function getCurrentInputText(): Promise<string | null> {
  try {
    // 保存当前剪贴板内容
    const originalClipboard = clipboard.readText();
    
    // 模拟全选操作 (Ctrl/Cmd+A)
    const selectAllKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(selectAllKey);
    await keyboard.pressKey(Key.A);
    await keyboard.releaseKey(Key.A);
    await keyboard.releaseKey(selectAllKey);
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // 模拟复制操作 (Ctrl/Cmd+C)
    const copyKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(copyKey);
    await keyboard.pressKey(Key.C);
    await keyboard.releaseKey(Key.C);
    await keyboard.releaseKey(copyKey);
    
    // 等待剪贴板更新
    await new Promise(resolve => setTimeout(resolve, 100));
    const inputText = clipboard.readText();
    
    // 恢复原始剪贴板内容
    clipboard.writeText(originalClipboard);
    
    // 取消选中 - 按右箭头键
    await keyboard.pressKey(Key.Right);
    await keyboard.releaseKey(Key.Right);
    
    return inputText && inputText.trim() ? inputText : null;
  } catch (error) {
    console.error('[Main] 获取输入框内容失败:', error);
    return null;
  }
}

// 获取指定索引的提示词
async function getPromptByIndex(index: number): Promise<string | null> {
  const store = new Store();
  const authToken = store.get('authToken') as string | undefined;
  
  if (!authToken) {
    console.error('[Main] 未找到认证Token');
    return null;
  }

  try {
    const baseUrl = getCurrentLanguageBaseUrl('en');
    const queryParams = new URLSearchParams();
    queryParams.append('page', '1');
    queryParams.append('limit', '100'); // 获取足够多的提示词
    queryParams.append('sortBy', 'useCount');
    queryParams.append('sortOrder', 'desc');
    
    const response = await fetch(`${baseUrl}/api/prompts/list?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'Authorization': `Token ${authToken}`,
        'Content-Type': 'application/json',
      }
    });

    if (response.ok) {
      const data = await response.json() as { success: boolean; data?: { prompts: any[] } };
      if (data.success && data.data && data.data.prompts) {
        const prompts = data.data.prompts;
        if (index >= 0 && index < prompts.length) {
          return prompts[index].content;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.error('[Main] 获取提示词失败:', error);
    return null;
  }
}

// 处理命令检测快捷键
async function handleCheckCommand(): Promise<void> {
  console.log('[Main] 命令检测快捷键触发');
  
  try {
    // 获取当前输入框内容
    const inputText = await getCurrentInputText();
    
    if (!inputText) {
      console.log('[Main] 未获取到输入框内容');
      return;
    }
    
    console.log('[Main] 获取到输入框内容:', inputText.substring(0, 50) + '...');
    
    // 匹配 /p<number> 格式的命令
    const commandRegex = /\/p(\d+)$/;
    const match = inputText.match(commandRegex);
    
    if (!match) {
      console.log('[Main] 未检测到命令');
      return;
    }
    
    const promptIndex = parseInt(match[1]) - 1;
    console.log('[Main] 检测到命令 /p' + (promptIndex + 1) + ', 索引: ' + promptIndex);
    
    // 获取对应的提示词
    const promptContent = await getPromptByIndex(promptIndex);
    
    if (!promptContent) {
      console.log('[Main] 未找到索引为 ' + promptIndex + ' 的提示词');
      return;
    }
    
    console.log('[Main] 获取到提示词内容:', promptContent.substring(0, 50) + '...');
    
    // 移除命令部分，保留其他内容
    const newText = inputText.replace(commandRegex, '') + promptContent;
    
    // 将新内容写入剪贴板
    clipboard.writeText(newText);
    
    // 全选当前输入框内容
    const selectAllKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(selectAllKey);
    await keyboard.pressKey(Key.A);
    await keyboard.releaseKey(Key.A);
    await keyboard.releaseKey(selectAllKey);
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // 粘贴新内容
    const pasteKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
    await keyboard.pressKey(pasteKey);
    await keyboard.pressKey(Key.V);
    await keyboard.releaseKey(Key.V);
    await keyboard.releaseKey(pasteKey);
    
    console.log('[Main] 命令处理完成');
  } catch (error) {
    console.error('[Main] 处理命令检测失败:', error);
  }
}

// 处理打开面板快捷键
async function handleOpenPanelShortcut(): Promise<void> {
  console.log('[Main] 打开面板快捷键触发');

  // 切换窗口显示/隐藏状态
  if (commandPaletteWindow.isVisible()) {
    commandPaletteWindow.hide();
  } else {
    // 获取鼠标所在屏幕的尺寸
    const mousePos = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(mousePos);

    // 计算窗口位置（屏幕中央）
    const x = Math.floor(display.bounds.x + (display.bounds.width - width) / 2);
    const y = Math.floor(display.bounds.y + (display.bounds.height - height) / 2);

    commandPaletteWindow.setPosition(x, y);
    commandPaletteWindow.setSize(width, height);

    // 显示并聚焦命令面板
    commandPaletteWindow.show();
    commandPaletteWindow.focus();
  }
}

// 处理快速保存选中文案快捷键
async function handleQuickSaveShortcut(): Promise<void> {
  console.log('[Main] 快速保存选中文案快捷键触发');
  await handleQuickSaveSelection();
}

// 获取用户快捷键设置
function getUserShortcutSettings(store: Store): UserShortcutSettings {
  const stored = store.get('shortcutSettings');
  if (stored && typeof stored === 'object') {
    return stored as UserShortcutSettings;
  }

  // 返回默认设置
  return {
    shortcuts: {
      openPanel: DEFAULT_SHORTCUTS.openPanel.defaultKey,
      quickSaveSelection: DEFAULT_SHORTCUTS.quickSaveSelection.defaultKey,
      checkCommand: DEFAULT_SHORTCUTS.checkCommand.defaultKey
    }
  };
}

// 注册全局快捷键
function registerGlobalShortcuts() {
  const store = new Store();
  const userSettings = getUserShortcutSettings(store);

  // 注销所有现有快捷键
  globalShortcut.unregisterAll();

  // 注册打开面板的快捷键
  const openPanelKey = userSettings.shortcuts.openPanel || DEFAULT_SHORTCUTS.openPanel.defaultKey;
  const openPanelRet = globalShortcut.register(openPanelKey, handleOpenPanelShortcut);

  if (!openPanelRet) {
    console.log(`打开面板快捷键注册失败: ${openPanelKey}`);
  } else {
    console.log(`打开面板快捷键注册成功: ${openPanelKey}`);
  }

  // 注册快速保存选中文案的快捷键
  const quickSaveKey = userSettings.shortcuts.quickSaveSelection || DEFAULT_SHORTCUTS.quickSaveSelection.defaultKey;
  const quickSaveRet = globalShortcut.register(quickSaveKey, handleQuickSaveShortcut);

  if (!quickSaveRet) {
    console.log(`快速保存快捷键注册失败: ${quickSaveKey}`);
  } else {
    console.log(`快速保存快捷键注册成功: ${quickSaveKey}`);
  }

  // 注册命令检测快捷键
  const checkCommandKey = userSettings.shortcuts.checkCommand || DEFAULT_SHORTCUTS.checkCommand.defaultKey;
  const checkCommandRet = globalShortcut.register(checkCommandKey, handleCheckCommand);

  if (!checkCommandRet) {
    console.log(`命令检测快捷键注册失败: ${checkCommandKey}`);
  } else {
    console.log(`命令检测快捷键注册成功: ${checkCommandKey}`);
  }
}

// IPC通信处理
app.whenReady().then(() => {
  // 清空旧日志并开始记录新日志
  clearLog();
  writeLog('=== Application Starting ===');
  writeLog(`NODE_ENV: ${process.env.NODE_ENV}`);
  writeLog(`Platform: ${process.platform}`);
  writeLog(`__dirname: ${__dirname}`);
  writeLog(`process.resourcesPath: ${process.resourcesPath}`);
  writeLog(`App path: ${app.getAppPath()}`);
  writeLog(`User data path: ${app.getPath('userData')}`);
  writeLog(`Log file path: ${getLogFilePath()}`);

  // 设置错误处理（在 app ready 之后）
  process.on('uncaughtException', (error) => {
    writeLog(`Uncaught Exception: ${error.message}\n${error.stack}`, 'ERROR');
  });

  process.on('unhandledRejection', (reason, promise) => {
    writeLog(`Unhandled Rejection: ${reason}`, 'ERROR');
  });

  ipcMain.on('copy-to-active-window', (event: any, content: string) => {
    console.log('[Main] 收到 copy-to-active-window 事件, 内容长度:', content.length);
    
    // 写入剪贴板
    clipboard.writeText(content);
    console.log('[Main] 已写入剪贴板');

    // 隐藏面板
    commandPaletteWindow.hide();
    console.log('[Main] 已隐藏面板窗口');

    // 等待窗口隐藏和焦点切换完成后，移动鼠标到之前位置并点击，然后粘贴
    setTimeout(async () => {
      try {
        // 如果有保存的鼠标位置，移动鼠标回去
        if (lastMousePosition) {
          console.log('[Main] 移动鼠标到之前位置:', lastMousePosition);
          await mouse.setPosition({ x: lastMousePosition.x, y: lastMousePosition.y });
          
          // 等待鼠标移动完成
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // 点击鼠标左键以激活输入框焦点
          console.log('[Main] 点击鼠标左键');
          await mouse.click(Button.LEFT);
          
          // 等待点击生效
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // 全选当前内容
        const selectAllKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
        await keyboard.pressKey(selectAllKey);
        await keyboard.pressKey(Key.A);
        await keyboard.releaseKey(Key.A);
        await keyboard.releaseKey(selectAllKey);
        
        // 等待全选操作完成
        await new Promise(resolve => setTimeout(resolve, 100));
        const pasteKey = process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl;
        await keyboard.pressKey(pasteKey);
        await keyboard.pressKey(Key.V);
        await keyboard.releaseKey(Key.V);
        await keyboard.releaseKey(pasteKey);
        console.log('[Main] 粘贴操作完成');
      } catch (error) {
        console.error('[Main] 模拟操作失败:', error);
      }
    }, 200);
  });

  ipcMain.on('hide-window', () => {
    commandPaletteWindow.hide();
  });

  // 切换窗口置顶状态
  ipcMain.handle('toggle-always-on-top', async () => {
    const currentState = commandPaletteWindow.isAlwaysOnTop();
    commandPaletteWindow.setAlwaysOnTop(!currentState);
    return !currentState;
  });

  // 创建 store 实例
  const store = new Store();

  // 从electron-store获取认证Token
  ipcMain.handle('get-auth-token', async () => {
    return store.get('authToken');
  });

  // 存储认证Token
  ipcMain.handle('set-auth-token', async (event: any, token: string) => {
    store.set('authToken', token);
  });

  // 获取语言设置
  ipcMain.handle('get-language', async () => {
    return store.get('language');
  });

  // 设置语言
  ipcMain.handle('set-language', async (event: any, language: string) => {
    store.set('language', language);
    // 语言更改后，重新初始化多语言并更新托盘菜单
    await initI18n(language as any);
    updateTrayMenu();
  });

  // 打开外部链接
  ipcMain.handle('shell-open-external', async (event: any, url: string) => {
    await shell.openExternal(url);
  });

  // 获取日志文件路径
  ipcMain.handle('get-log-path', async () => {
    return getLogFilePath();
  });

  // 打开日志文件所在目录
  ipcMain.handle('open-log-directory', async () => {
    const logPath = getLogFilePath();
    const logDir = path.dirname(logPath);
    await shell.openPath(logDir);
  });

  // 获取快捷键设置
  ipcMain.handle('get-shortcut-settings', async () => {
    const store = new Store();
    return getUserShortcutSettings(store);
  });

  // 保存快捷键设置
  ipcMain.handle('set-shortcut-settings', async (event: any, settings: UserShortcutSettings) => {
    const store = new Store();
    store.set('shortcutSettings', settings);
    // 重新注册快捷键
    registerGlobalShortcuts();

    writeLog(`快捷键设置已更新: ${JSON.stringify(settings)}`);
    return true;
  });

  // 重置快捷键设置到默认值
  ipcMain.handle('reset-shortcut-settings', async () => {
    const store = new Store();
    const defaultSettings: UserShortcutSettings = {
      shortcuts: {
        openPanel: DEFAULT_SHORTCUTS.openPanel.defaultKey,
        quickSaveSelection: DEFAULT_SHORTCUTS.quickSaveSelection.defaultKey,
        checkCommand: DEFAULT_SHORTCUTS.checkCommand.defaultKey
      }
    };

    store.set('shortcutSettings', defaultSettings);
    // 重新注册快捷键
    registerGlobalShortcuts();

    writeLog('快捷键设置已重置为默认值');
    return defaultSettings;
  });

  // 获取默认快捷键配置
  ipcMain.handle('get-default-shortcuts', async () => {
    return DEFAULT_SHORTCUTS;
  });

  // 更新快捷键绑定（在设置更改后调用）
  ipcMain.handle('update-shortcuts', async () => {
    registerGlobalShortcuts();
    return true;
  });

  // API 请求代理（避免 CORS 问题）
  ipcMain.handle('api-request', async (event: any, options: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: any;
  }) => {
    try {
      const { url, method, headers, body } = options;
      
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      
      const data = await response.json();
      
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        data,
      };
    } catch (error: any) {
      console.error('API request failed:', error);
      return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        data: { success: false, error: { message: error.message } },
      };
    }
  });

  // 初始化应用
  try {
    writeLog('Creating tray...');
    createTray();

    writeLog('Creating command palette window...');
    createCommandPaletteWindow();

    writeLog('Registering global shortcuts...');
    registerGlobalShortcuts();

    writeLog('Application initialized successfully');
  } catch (error: any) {
    writeLog(`Failed to initialize application: ${error.message}\n${error.stack}`, 'ERROR');
    throw error;
  }

  // macOS特殊处理
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
}).catch((error) => {
  writeLog(`App ready failed: ${error.message}\n${error.stack}`, 'ERROR');
  // 显示错误对话框
  dialog.showErrorBox(
    'Application Startup Error',
    `Failed to start application.\n\nLog file location:\n${getLogFilePath()}\n\nError: ${error.message}`
  );
  app.quit();
});

// 应用退出处理
app.on('window-all-closed', () => {
  // 桌面应用不需要在关闭所有窗口时退出（托盘应用）
  // 注释掉默认退出行为
  // if (process.platform !== 'darwin') {
  //   app.quit();
  // }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 当应用激活时（macOS）
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createCommandPaletteWindow();
  }
});