/**
 * 公司內部點餐工具 Core Logic
 * 
 * 功能：
 * 1. Google Identity Services 登入
 * 2. Google Sheets API 讀取與寫入
 * 3. 權限控管 (Admin/Staff)
 * 4. 點餐與訂單管理
 */

// --- 設定 ---
const CONFIG = {
    // 請填入您的 GCP Client ID
    CLIENT_ID: '768071495555-eltu7kj8of1qr6psqpqia3o4f6rpsj4j.apps.googleusercontent.com',
    // 請填入您的 GCP API Key
    API_KEY: 'AIzaSyBt5RhmXt9TdfSMJxR-R3NI4ChqBmpqzAM',
    // 請填入您的 Google Sheet ID
    SPREADSHEET_ID: '13NpYfhHM7LDV_vBUrp072u7y_cjmcRbtqAAJGuh-CwI',

    // Google Sheets Discovery Doc
    DISCOVERY_DOC: 'https://sheets.googleapis.com/$discovery/rest?version=v4',
    // 授權範圍 (讀寫試算表 + 使用者資訊)
    SCOPES: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid',
};

// --- 全域變數 ---
let tokenClient;
let gapiInited = false;
let gisInited = false;
let currentUser = null; // { email, name, role }

// Sheet 名稱對照
const SHEETS = {
    TODAY: 'TodayConfig',
    MENU: 'Menu',
    USERS: 'Users',
    ORDERS: 'Orders'
};

/**
 * 程式進入點
 */
document.addEventListener('DOMContentLoaded', () => {
    // 綁定按鈕事件
    document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
    document.getElementById('btn-open-config').addEventListener('click', showConfigPanel);
    document.getElementById('btn-save-config').addEventListener('click', saveTodayConfig);
    document.getElementById('btn-clear-orders').addEventListener('click', clearOrders);
    document.getElementById('btn-show-orders').addEventListener('click', openOrdersModal);
    document.querySelector('.close-modal').addEventListener('click', closeOrdersModal);
    document.getElementById('btn-copy-orders').addEventListener('click', copyOrdersToClipboard);

    // 登入按鈕綁定
    const loginBtn = document.getElementById('custom-login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', handleLoginClick);
    }

    // 關閉 Modal (點擊背景)
    window.onclick = function (event) {
        const modal = document.getElementById('orders-modal');
        if (event.target == modal) {
            closeOrdersModal();
        }
    }

    // 先初始化 GAPI，完成後再嘗試自動登入
    initGapiClient().then(() => {
        console.log("GAPI ready, trying auto login...");
        tryAutoLogin();
    }).catch(err => {
        console.error("GAPI init failed:", err);
        showLogin();
    });
});

// --- Google API 初始化 ---

/**
 * 處理登入按鈕點擊
 */
async function handleLoginClick() {
    try {
        showLoading('正在連線...');
        // 確保 GAPI 已載入
        await initGapiClient();
        // 強制彈出授權視窗 (取得新 Token)
        const token = await requestAccessToken(true);
        // 取得 Token 後進行後續載入
        await handleAuthFlow(token);
    } catch (err) {
        console.error("Login failed:", err);
        alert("登入失敗，請重試。");
        showLogin();
        hideLoading();
    }
}

/**
 * 嘗試自動登入 (用 LocalStorage 裡的 cached token)
 */
async function tryAutoLogin() {
    const savedToken = loadTokenFromStorage();
    if (!savedToken) {
        showLogin();
        return;
    }

    console.log("Found cached token, auto logging in...");
    // 設定 token 到 gapi client (此時 gapi 已初始化)
    gapi.client.setToken({ access_token: savedToken });

    try {
        await handleAuthFlow(savedToken);
    } catch (err) {
        console.warn("Auto login failed, clearing cached token:", err);
        // 自動登入失敗 → 清除舊 token，顯示登入按鈕
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXP_KEY);
        gapi.client.setToken('');
        showLogin();
        hideLoading();
    }
}

/**
 * 主要授權與載入資料流程
 * @param {string} accessToken
 */
async function handleAuthFlow(accessToken) {
    showLoading('正在驗證身分並載入權限...');
    hideLogin();

    // 確保 gapi client 有正確的 token
    gapi.client.setToken({ access_token: accessToken });

    // 1. 取得使用者 Profile
    const profile = await fetchUserProfile(accessToken);
    if (!profile || !profile.email) {
        // Token 無效或 scope 不足，清除並要求重登
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXP_KEY);
        gapi.client.setToken('');
        throw new Error("無法取得使用者資訊，Token 可能已過期或權限不足。");
    }

    const email = profile.email;
    const name = profile.name || email.split('@')[0];
    console.log("User:", email, name);

    // 2. 讀取 Users 表確認身分
    const userRole = await checkUserPermission(email);

    if (!userRole) {
        alert('抱歉，您不在授權名單中。請聯繫管理員。');
        handleSignOut();
        return;
    }

    currentUser = { email, name, role: userRole };
    updateUIForUser();

    // 3. 載入資料
    await loadAppArgs();
}

/**
 * 使用 Access Token 取得 User Profile
 */
async function fetchUserProfile(accessToken) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        });
        if (!response.ok) throw new Error('Failed to fetch user profile');
        return await response.json();
    } catch (err) {
        console.error(err);
        return null;
    }
}

/**
 * 初始化 GAPI Client
 */
function initGapiClient() {
    return new Promise((resolve, reject) => {
        if (gapiInited) {
            resolve();
            return;
        }
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    apiKey: CONFIG.API_KEY,
                    discoveryDocs: [CONFIG.DISCOVERY_DOC],
                });
                gapiInited = true;
                resolve();
            } catch (err) {
                console.error("Error initializing GAPI client", err);
                reject(err);
            }
        });
    });
}

/**
 * 請求 Access Token
 * @param {boolean} forcePrompt 是否強制顯示彈窗
 */
function requestAccessToken(forcePrompt = false) {
    return new Promise((resolve, reject) => {
        // [新增] 檢查 LocalStorage 是否有有效的 Token (僅在非強制模式下)
        if (!forcePrompt) {
            const savedToken = loadTokenFromStorage();
            if (savedToken) {
                console.log("Using valid cached token.");
                // 設定 gapi client token
                gapi.client.setToken({ access_token: savedToken });
                resolve(savedToken);
                return;
            }
        }

        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: (tokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    // [新增] 儲存 Token
                    saveTokenToStorage(tokenResponse);
                    resolve(tokenResponse.access_token);
                } else {
                    reject("Failed to get access token");
                }
            },
            error_callback: (err) => {
                reject(err);
            }
        });

        if (forcePrompt) {
            // 強制顯示彈窗
            tokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
            // 嘗試靜默或預設
            tokenClient.requestAccessToken({ prompt: '' });
        }
    });
}

// --- Token Persistence Helpers ---
const TOKEN_KEY = 'google_access_token';
const TOKEN_EXP_KEY = 'google_token_expires_at';

function saveTokenToStorage(tokenResponse) {
    const expiresIn = tokenResponse.expires_in || 3599; // 預設 1小時
    const now = Date.now();
    // 提早 5 分鐘過期，避免邊界狀況
    const expiresAt = now + (expiresIn * 1000) - (5 * 60 * 1000);

    localStorage.setItem(TOKEN_KEY, tokenResponse.access_token);
    localStorage.setItem(TOKEN_EXP_KEY, expiresAt);
}

function loadTokenFromStorage() {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiresAt = localStorage.getItem(TOKEN_EXP_KEY);

    if (!token || !expiresAt) return null;

    if (Date.now() < parseInt(expiresAt)) {
        return token;
    } else {
        console.log("Cached token expired.");
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXP_KEY);
        return null;
    }
}

function handleSignOut() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
    }
    // [新增] 清除 LocalStorage
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);

    currentUser = null;
    document.getElementById('user-info').classList.add('hidden');
    document.getElementById('app-section').classList.add('hidden');
    document.getElementById('order-summary-section').classList.add('hidden');
    showLogin();
}


// --- 業務邏輯 ---

/**
 * 檢查使用者權限
 * 回傳 role ('管理員', '一般成員') 或 null
 */
async function checkUserPermission(email) {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.USERS}!A:C`, // 假設 A:姓名, B:Email, C:權限
        });

        const rows = response.result.values;
        if (!rows || rows.length === 0) return null;

        // 尋找 Email 匹配的列
        // header: 姓名, Email, 權限
        // 略過第一列 (Header)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const userEmail = row[1]; // B欄
            if (userEmail === email) {
                return row[2]; // C欄：權限
            }
        }
        return null;
    } catch (err) {
        console.error("Error checking permission:", err);
        return null;
    }
}

async function loadAppArgs() {
    showLoading('載入菜單中...');
    try {
        // 1. 取得今日餐廳設定
        const todayConfig = await getTodayRestaurants();
        document.getElementById('today-restaurants').textContent = todayConfig.length > 0 ? `(${todayConfig.join(', ')})` : '(尚未設定)';

        // 2. 取得所有菜單 並 過濾
        const allMenu = await getAllMenu();

        // 3. 渲染介面
        renderMenu(todayConfig, allMenu);

        hideLoading();
        document.getElementById('app-section').classList.remove('hidden');

    } catch (err) {
        console.error("Error loading app data:", err);
        alert("載入資料失敗，請檢查網路或 API 設定。");
        hideLoading();
    }
}

// 取得今日餐廳 (TodayConfig Sheet)
async function getTodayRestaurants() {
    const response = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${SHEETS.TODAY}!A:A`, // 假設 A 欄是今日餐廳
    });
    const rows = response.result.values;
    if (!rows || rows.length <= 1) return [];

    // 排除標題列, 取第一欄
    return rows.slice(1).map(row => row[0]).filter(val => val);
}

// 取得完整菜單 (Menu Sheet)
async function getAllMenu() {
    const response = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${SHEETS.MENU}!A:D`, // 餐廳名稱, 品名, 單價, 分類
    });
    const rows = response.result.values;
    // 轉換為物件陣列
    // Header: 餐廳名稱, 品名, 單價, 分類
    if (!rows || rows.length <= 1) return [];

    return rows.slice(1).map(row => ({
        restaurant: row[0],
        name: row[1],
        price: row[2],
        category: row[3]
    }));
}

// 渲染菜單
function renderMenu(todayRestaurants, allMenu) {
    const container = document.getElementById('menu-container');
    container.innerHTML = '';

    if (todayRestaurants.length === 0) {
        container.innerHTML = '<p>今日尚未設定餐廳，請稍候或聯繫管理員。</p>';
        return;
    }

    // 過濾出今日餐廳的餐點
    const todayMenu = allMenu.filter(item => todayRestaurants.includes(item.restaurant));

    if (todayMenu.length === 0) {
        container.innerHTML = '<p>找不到今日餐廳的菜單資料。</p>';
        return;
    }

    todayMenu.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card menu-item';
        card.innerHTML = `
            <h4>${item.restaurant} - ${item.name}</h4>
            <div class="price">$${item.price}</div>
            <div class="category text-secondary">${item.category}</div>
            <input type="text" class="note-input" placeholder="備註 (例如：少冰、不要香菜)">
            <button class="btn btn-primary btn-order" onclick="submitOrder('${item.restaurant}', '${item.name}', '${item.price}', this)">點餐</button>
        `;
        container.appendChild(card);
    });
}

// 送出訂單
async function submitOrder(restaurant, foodName, price, btnElement) {
    if (!currentUser) return;

    const card = btnElement.parentElement;
    const note = card.querySelector('.note-input').value;
    const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });

    // 禁用按鈕避免重複
    btnElement.disabled = true;
    btnElement.textContent = '處理中...';

    const orderData = [
        timestamp,
        currentUser.email,
        restaurant,
        foodName,
        price,
        note
    ];

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.ORDERS}!A:F`,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [orderData]
            }
        });

        alert(`點餐成功：${foodName}`);
        card.querySelector('.note-input').value = ''; // 清空備註
    } catch (err) {
        console.error("Order failed", err);
        alert("點餐失敗，請重試。");
    } finally {
        btnElement.disabled = false;
        btnElement.textContent = '點餐';
    }
}


// --- 管理員功能 ---

async function showConfigPanel() {
    // 1. 讀取所有可用的餐廳 (從 Menu 中取出所有唯一餐廳名)
    // 2. 顯示 Checkbox
    const panel = document.getElementById('admin-config-panel');
    const container = document.getElementById('restaurant-checkboxes');
    container.innerHTML = '讀取中...';
    panel.classList.remove('hidden');

    try {
        const allMenu = await getAllMenu();
        const restaurants = [...new Set(allMenu.map(item => item.restaurant))];

        container.innerHTML = '';
        restaurants.forEach(r => {
            const div = document.createElement('div');
            div.innerHTML = `
                <label>
                    <input type="checkbox" value="${r}" name="restaurant-select"> ${r}
                </label>
            `;
            container.appendChild(div);
        });

    } catch (err) {
        container.textContent = '載入餐廳失敗';
    }
}

async function saveTodayConfig() {
    const checkboxes = document.querySelectorAll('input[name="restaurant-select"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);

    if (selected.length === 0) {
        if (!confirm('確定不選擇任何餐廳嗎？(將清空今日設定)')) return;
    }

    try {
        // 先清空 TodayConfig Sheet
        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.TODAY}!A2:A` // 保留標題
        });

        if (selected.length > 0) {
            // 寫入新設定
            const values = selected.map(r => [r]);
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: CONFIG.SPREADSHEET_ID,
                range: `${SHEETS.TODAY}!A2`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: values }
            });
        }

        alert('設定已儲存！');
        document.getElementById('admin-config-panel').classList.add('hidden');
        // 重新載入介面
        loadAppArgs();

    } catch (err) {
        console.error(err);
        alert('儲存失敗');
    }
}

async function clearOrders() {
    if (!confirm('⚠️ 警告：確定要清空今日所有訂單資料嗎？此動作無法復原！')) return;

    try {
        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.ORDERS}!A2:F` // 保留標題
        });
        alert('訂單已清空。');
    } catch (err) {
        console.error(err);
        alert('清空失敗');
    }
}


// --- 訂單檢視功能 ---

async function openOrdersModal() {
    const modal = document.getElementById('orders-modal');
    const tbody = document.getElementById('orders-list');
    const totalSpan = document.getElementById('total-amount');

    tbody.innerHTML = '<tr><td colspan="6">載入中...</td></tr>';
    modal.classList.remove('hidden');

    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.ORDERS}!A2:F`,
        });

        const rows = response.result.values || [];
        tbody.innerHTML = '';

        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6">目前沒有訂單。</td></tr>';
            totalSpan.textContent = '0';
            return;
        }

        let total = 0;
        rows.forEach(row => {
            // [時間, Email, 餐廳, 餐點, 金額, 備註]
            const tr = document.createElement('tr');
            // 簡單過濾 html tag 防止 XSS (如果需要)
            const price = parseInt(row[4]) || 0;
            total += price;

            tr.innerHTML = `
                <td>${row[0]}</td>
                <td>${row[1]}</td>
                <td>${row[2]}</td>
                <td>${row[3]}</td>
                <td>${row[4]}</td>
                <td>${row[5] || ''}</td>
            `;
            tbody.appendChild(tr);
        });

        totalSpan.textContent = total;

    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="6">載入失敗</td></tr>';
    }
}

function closeOrdersModal() {
    document.getElementById('orders-modal').classList.add('hidden');
}

function copyOrdersToClipboard() {
    // 將訂單轉為純文字格式
    const rows = document.querySelectorAll('#orders-list tr');
    let text = "📋 今日點餐清單：\n\n";

    rows.forEach(row => {
        const cols = row.querySelectorAll('td');
        if (cols.length < 5) return; // Skip empty/loading
        // 時間, Email, 餐廳, 餐點, 金額, 備註
        // 格式: [餐廳] 餐點 ($金額) - Email / 備註
        const restaurant = cols[2].textContent;
        const food = cols[3].textContent;
        const price = cols[4].textContent;
        const email = cols[1].textContent.split('@')[0]; // 只取 user part
        const note = cols[5].textContent ? `(${cols[5].textContent})` : '';

        text += `[${restaurant}] ${food} $${price} - ${email} ${note}\n`;
    });

    const total = document.getElementById('total-amount').textContent;
    text += `\n💰 總金額：${total} 元`;

    navigator.clipboard.writeText(text).then(() => {
        alert('已複製到剪貼簿！');
    }, () => {
        alert('複製失敗，請手動複製。');
    });
}


// --- UI Helper ---

function showLoading(msg) {
    document.getElementById('status-section').classList.remove('hidden');
    document.getElementById('status-text').textContent = msg || '載入中...';
}

function hideLoading() {
    document.getElementById('status-section').classList.add('hidden');
}

function showLogin() {
    document.getElementById('login-section').classList.remove('hidden');
    document.getElementById('app-section').classList.add('hidden');
}

function hideLogin() {
    document.getElementById('login-section').classList.add('hidden');
}

function updateUIForUser() {
    document.getElementById('user-info').classList.remove('hidden');
    document.getElementById('user-name').textContent = `${currentUser.name} (${currentUser.role})`;

    if (currentUser.role === '管理員') {
        document.getElementById('admin-section').classList.remove('hidden');
    } else {
        document.getElementById('admin-section').classList.add('hidden');
    }

    document.getElementById('order-summary-section').classList.remove('hidden');
}

