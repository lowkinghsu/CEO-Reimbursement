// Google Drive API Integration
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILENAME = 'ReimburseAI_Backup.json';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let accessToken = null;

// 由 index.html 載入 gapi 後自動呼叫
function gapiLoad() {
  gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
  try {
    await gapi.client.init({
      discoveryDocs: [DISCOVERY_DOC],
    });
    gapiInited = true;
    maybeEnableAuth();
  } catch (err) {
    console.error('Error initializing GAPI client:', err);
  }
}

// 初始化 GIS (Google Identity Services)
function initGis() {
  const clientId = localStorage.getItem('gdriveClientId');
  if (!clientId) return;
  
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error !== undefined) {
        throw (resp);
      }
      accessToken = resp.access_token;
      updateAuthUI(true);
      toast('✅ 成功連結 Google 雲端硬碟', 'ok');
    },
  });
  gisInited = true;
  maybeEnableAuth();
}

function maybeEnableAuth() {
  if (gapiInited && gisInited) {
    // Check if token exists in session
    if (accessToken) {
      updateAuthUI(true);
    }
  }
}

// 每次 clientId 變更時，重新初始化 GIS
window.initGapi = function() {
  if (typeof google !== 'undefined') {
    initGis();
  }
}

// 監聽全局載入事件
window.addEventListener('load', () => {
  // 延遲初始化確保腳本已載入
  setTimeout(() => {
    if (typeof gapi !== 'undefined') gapiLoad();
    if (typeof google !== 'undefined') initGis();
  }, 1000);
});

function updateAuthUI(isSignedIn) {
  document.getElementById('gdrive-auth-container').style.display = isSignedIn ? 'none' : 'block';
  document.getElementById('gdrive-sync-container').style.display = isSignedIn ? 'block' : 'none';
}

function handleAuthClick() {
  const clientId = localStorage.getItem('gdriveClientId');
  if (!clientId) {
    toast('請先輸入 Google Client ID', 'er');
    return;
  }
  
  if (!tokenClient) {
    initGis();
  }

  if (gapi.client.getToken() === null) {
    // Request an access token
    tokenClient.requestAccessToken({prompt: 'consent'});
  } else {
    // Skip display of account chooser and consent dialog for an existing session.
    tokenClient.requestAccessToken({prompt: ''});
  }
}

function handleSignoutClick() {
  const token = gapi.client.getToken();
  if (token !== null) {
    google.accounts.oauth2.revoke(token.access_token, () => {
      gapi.client.setToken('');
      accessToken = null;
      updateAuthUI(false);
      toast('已登出 Google 帳號', 'ok');
    });
  }
}

// 搜尋備份檔案
async function findBackupFile() {
  let response;
  try {
    response = await gapi.client.drive.files.list({
      q: `name='${BACKUP_FILENAME}' and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    });
  } catch (err) {
    throw new Error('尋找備份檔案失敗: ' + err.message);
  }
  const files = response.result.files;
  if (files && files.length > 0) {
    return files[0].id;
  }
  return null;
}

// 備份到雲端硬碟
window.syncToDrive = async function() {
  if (!accessToken) {
    toast('請先登入授權', 'er');
    return;
  }

  try {
    toast('🔄 正在打包備份資料...');
    const allData = await dbGetAll();
    const fileContent = JSON.stringify(allData);
    const fileMetadata = {
      name: BACKUP_FILENAME,
      mimeType: 'application/json'
    };

    const fileId = await findBackupFile();
    
    toast('☁️ 正在上傳至雲端硬碟...');
    
    // 使用 XMLHttpRequest 或 fetch 上傳內容，因為 gapi.client.drive.files.create/update 不支援直接傳入大型內文
    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    const multipartRequestBody =
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        JSON.stringify(fileMetadata) +
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        fileContent +
        close_delim;

    let path = '/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';

    if (fileId) {
      path = `/upload/drive/v3/files/${fileId}?uploadType=multipart`;
      method = 'PATCH';
    }

    const request = gapi.client.request({
        'path': path,
        'method': method,
        'params': {'uploadType': 'multipart'},
        'headers': {
          'Content-Type': 'multipart/related; boundary="' + boundary + '"'
        },
        'body': multipartRequestBody});
    
    await request;
    toast('✅ 備份成功！', 'ok');
  } catch (err) {
    console.error(err);
    toast('備份失敗: ' + (err.message || '未知錯誤'), 'er');
  }
}

// 從雲端硬碟還原
window.syncFromDrive = async function() {
  if (!accessToken) {
    toast('請先登入授權', 'er');
    return;
  }
  
  if (!confirm('⚠️ 警告：還原會將目前的資料完全覆蓋為雲端版本。確定要繼續嗎？')) {
    return;
  }

  try {
    toast('🔄 正在尋找雲端備份...');
    const fileId = await findBackupFile();
    if (!fileId) {
      toast('找不到備份檔案 (ReimburseAI_Backup.json)', 'er');
      return;
    }

    toast('☁️ 正在下載資料...');
    const response = await gapi.client.drive.files.get({
      fileId: fileId,
      alt: 'media'
    });
    
    const data = response.result;
    if (!Array.isArray(data)) {
      throw new Error('備份檔案格式錯誤');
    }

    toast('🔄 正在還原資料庫...');
    
    // 清空現有資料表並重新匯入
    const dbTransaction = db.transaction(ST, 'readwrite');
    const store = dbTransaction.objectStore(ST);
    store.clear();
    
    let ok = 0;
    for (const rec of data) {
      store.add(rec);
      ok++;
    }
    
    toast(`✅ 成功還原 ${ok} 筆資料`, 'ok');
    
    // 更新 UI
    setTimeout(() => {
      allExp = [];
      if (curView === 'home') refreshHome();
      if (curView === 'list') refreshList();
    }, 1000);
    
  } catch (err) {
    console.error(err);
    toast('還原失敗: ' + (err.message || '未知錯誤'), 'er');
  }
}
