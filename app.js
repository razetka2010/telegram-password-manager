// Глобальные переменные
let tg = null;
let currentUser = null;
let currentUserId = null;
let encryptionKey = null;
let currentPasswords = [];
let sessionToken = null;
let isEditMode = false;
let editPasswordId = null;

// Для тестирования в обычном браузере
if (typeof window !== 'undefined' && !window.Telegram?.WebApp) {
    console.log('⚠️ Running in browser mode (not Telegram)');
    
    // Создаем мок Telegram WebApp
    window.Telegram = {
        WebApp: {
            initData: 'user={"id":123456789,"first_name":"Test","username":"testuser","language_code":"ru"}',
            platform: 'web',
            version: '7.0',
            expand: function() { console.log('Mock: expand') },
            ready: function() { console.log('Mock: ready') },
            MainButton: {
                setText: function(text) { console.log('Mock: MainButton.setText', text); return this },
                show: function() { console.log('Mock: MainButton.show'); return this },
                onClick: function(callback) { console.log('Mock: MainButton.onClick'); callback && callback() }
            },
            showAlert: function(message) { 
                console.log('Mock: showAlert', message);
                alert(message);
            },
            HapticFeedback: {
                impactOccurred: function(type) { console.log('Mock: HapticFeedback', type) }
            },
            showConfirm: function(message, callback) {
                console.log('Mock: showConfirm', message);
                const result = confirm(message);
                callback && callback(result);
            }
        }
    };
}

// Для отладки
window.debugState = () => {
    return {
        tg: !!tg,
        currentUser: currentUser,
        currentUserId: currentUserId,
        sessionToken: sessionToken ? sessionToken.substring(0, 20) + '...' : null,
        currentPasswords: currentPasswords,
        passwordsCount: currentPasswords.length
    };
};

// Инициализация приложения
async function initApp() {
    try {
        console.log('🚀 Starting app initialization...');
        console.log('Debug state:', window.debugState());

        // Инициализируем Telegram WebApp
        tg = window.Telegram.WebApp;
        tg.expand();
        tg.ready();

        console.log('📱 Telegram WebApp initialized');
        console.log('Init Data:', tg.initData);
        console.log('Platform:', tg.platform);
        console.log('Version:', tg.version);

        // Получаем initData
        const initData = tg.initData;

        // Отправляем на сервер для авторизации
        console.log('🔐 Sending auth request...');
        const response = await fetch('/api/auth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                initData: initData,
                platform: tg.platform,
                version: tg.version
            })
        });

        console.log('📨 Auth response status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Auth error response:', errorText);
            throw new Error(`Auth failed: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        console.log('📊 Auth response data:', data);

        if (data.success) {
            currentUser = data.user.telegram;
            currentUserId = data.user.database.id;
            sessionToken = data.session_token;

            // Сохраняем токен в localStorage
            localStorage.setItem('telegram_session', sessionToken);
            console.log('✅ Session token saved to localStorage, user ID:', currentUserId);

            // Показываем информацию о пользователе
            document.getElementById('user-name').textContent =
                currentUser.first_name || currentUser.username || 'Пользователь';

            // Устанавливаем фото если есть
            if (currentUser.photo_url) {
                document.getElementById('user-photo').src = currentUser.photo_url;
            } else {
                // Генерируем аватар по умолчанию
                const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.first_name || 'U')}&background=2481cc&color=fff&size=40`;
                document.getElementById('user-photo').src = defaultAvatar;
            }

            // Генерируем ключ шифрования
            await generateEncryptionKey();

            // Загружаем пароли
            await loadPasswords();

            // Показываем приложение
            document.getElementById('loader').classList.add('hidden');
            document.getElementById('app').classList.remove('hidden');

            // Добавляем кнопку в Telegram
            if (tg.MainButton) {
                tg.MainButton.setText("Мои пароли").show();
                tg.MainButton.onClick(() => {
                    tg.showAlert(`У вас ${currentPasswords.length} сохраненных паролей`);
                });
            }

            console.log('✅ App initialized successfully');
            console.log('Current passwords:', currentPasswords);

        } else {
            console.error('Auth failed:', data);
            throw new Error(data.message || 'Auth failed');
        }

    } catch (error) {
        console.error('❌ Initialization error:', error);
        
        // Показываем подробную ошибку пользователю
        document.getElementById('loader').innerHTML = `
            <div style="text-align: center; padding: 20px;">
                <h3 style="color: #dc3545;">Ошибка загрузки</h3>
                <p style="margin: 10px 0;">${error.message || 'Неизвестная ошибка'}</p>
                <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 8px; text-align: left;">
                    <p style="font-weight: bold; margin-bottom: 5px;">Отладочная информация:</p>
                    <p style="font-size: 12px; color: #666; margin: 2px 0;">URL: ${window.location.href}</p>
                    <p style="font-size: 12px; color: #666; margin: 2px 0;">Время: ${new Date().toLocaleString()}</p>
                    <p style="font-size: 12px; color: #666; margin: 2px 0;">Ошибка: ${error.toString()}</p>
                </div>
                <div style="margin-top: 20px;">
                    <button onclick="location.reload()" style="
                        background: #2481cc;
                        color: white;
                        border: none;
                        padding: 12px 24px;
                        border-radius: 8px;
                        margin: 5px;
                        cursor: pointer;
                        font-size: 16px;
                    ">Перезагрузить</button>
                    <button onclick="testConnection()" style="
                        background: #28a745;
                        color: white;
                        border: none;
                        padding: 12px 24px;
                        border-radius: 8px;
                        margin: 5px;
                        cursor: pointer;
                        font-size: 16px;
                    ">Тест подключения</button>
                </div>
            </div>
        `;
    }
}

// Тест подключения
window.testConnection = async function() {
    try {
        const response = await fetch('/api/health');
        const data = await response.json();
        
        tg.showAlert(`Сервер: ${data.status}\nБаза: ${data.database?.connected ? 'OK' : 'Ошибка'}\nТаблицы: ${data.tables}`);
    } catch (error) {
        tg.showAlert(`Ошибка подключения: ${error.message}`);
    }
};

// Генерация ключа шифрования
async function generateEncryptionKey() {
    try {
        console.log('🔑 Generating encryption key...');
        
        if (!currentUser || !currentUser.id) {
            throw new Error('No user ID for key generation');
        }

        // Используем Telegram ID как основу для ключа
        const keyMaterial = await window.crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(currentUser.id.toString() + 'telegram-password-manager-secret'),
            { name: "PBKDF2" },
            false,
            ["deriveKey"]
        );

        encryptionKey = await window.crypto.subtle.deriveKey(
            {
                name: "PBKDF2",
                salt: new TextEncoder().encode("telegram-password-manager-salt"),
                iterations: 100000,
                hash: "SHA-256"
            },
            keyMaterial,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );

        console.log('✅ Encryption key generated');
    } catch (error) {
        console.error('❌ Key generation error:', error);
        throw error;
    }
}

// Шифрование пароля
async function encryptPassword(password) {
    try {
        console.log('🔒 Encrypting password...');
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(password);

        const encrypted = await window.crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv
            },
            encryptionKey,
            encoded
        );

        // Преобразуем в base64
        const encryptedArray = new Uint8Array(encrypted);
        let encryptedString = '';
        for (let i = 0; i < encryptedArray.length; i++) {
            encryptedString += String.fromCharCode(encryptedArray[i]);
        }

        let ivString = '';
        for (let i = 0; i < iv.length; i++) {
            ivString += String.fromCharCode(iv[i]);
        }

        const result = {
            encrypted: btoa(encryptedString),
            iv: btoa(ivString)
        };
        
        console.log('✅ Password encrypted');
        return result;
    } catch (error) {
        console.error('❌ Encryption error:', error);
        tg.showAlert('Ошибка шифрования пароля');
        throw error;
    }
}

// Дешифрование пароля
async function decryptPassword(encryptedData, iv) {
    try {
        const encryptedBinary = atob(encryptedData);
        const encryptedArray = new Uint8Array(encryptedBinary.length);
        for (let i = 0; i < encryptedBinary.length; i++) {
            encryptedArray[i] = encryptedBinary.charCodeAt(i);
        }

        const ivBinary = atob(iv);
        const ivArray = new Uint8Array(ivBinary.length);
        for (let i = 0; i < ivBinary.length; i++) {
            ivArray[i] = ivBinary.charCodeAt(i);
        }

        const decrypted = await window.crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: ivArray
            },
            encryptionKey,
            encryptedArray
        );

        return new TextDecoder().decode(decrypted);
    } catch (error) {
        console.error('❌ Decryption error:', error);
        return '***Ошибка дешифрования***';
    }
}

// Аутентифицированный запрос
async function makeAuthenticatedRequest(url, options = {}) {
    if (!sessionToken) {
        console.error('❌ No session token');
        tg.showAlert('Сессия не найдена. Перезагрузите приложение.');
        return null;
    }

    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + sessionToken
    };

    console.log('📡 Making request to:', url);
    console.log('📡 Request method:', options.method || 'GET');

    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                ...defaultHeaders,
                ...options.headers
            }
        });

        console.log('📡 Response status:', response.status);

        if (response.status === 401) {
            tg.showAlert('Сессия истекла. Перезагрузите приложение.');
            return null;
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ Request failed:', response.status, errorText);
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        return response;
    } catch (error) {
        console.error('❌ Request error:', error);
        tg.showAlert('Ошибка подключения к серверу: ' + error.message);
        return null;
    }
}

// Загрузка паролей
async function loadPasswords() {
    try {
        console.log('📥 Loading passwords...');
        const response = await makeAuthenticatedRequest('/api/passwords');
        if (!response) return;

        const data = await response.json();
        console.log('📦 Passwords loaded:', data);

        if (data.success) {
            currentPasswords = data.passwords || [];
            console.log(`✅ Loaded ${currentPasswords.length} passwords`);
            renderPasswords();
            updateStats();
        } else {
            console.error('Failed to load passwords:', data);
            tg.showAlert(data.message || 'Ошибка загрузки паролей');
        }
    } catch (error) {
        console.error('❌ Error loading passwords:', error);
        tg.showAlert('Ошибка при загрузке паролей: ' + error.message);
    }
}

// Отображение паролей
function renderPasswords() {
    const list = document.getElementById('passwords-list');
    list.innerHTML = '';

    if (currentPasswords.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-lock-open"></i>
                <p>Пока нет сохраненных паролей</p>
                <p style="font-size: 14px; color: #888;">Добавьте ваш первый пароль выше</p>
            </div>
        `;
        return;
    }

    for (const item of currentPasswords) {
        const div = document.createElement('div');
        div.className = 'password-item';
        div.dataset.id = item.id;

        div.innerHTML = `
            <div class="service-info">
                <div class="service-name">${escapeHtml(item.service_name)}</div>
                <div class="login">${escapeHtml(item.login)}</div>
                <div class="date">${new Date(item.created_at).toLocaleDateString()}</div>
            </div>
            <div class="password-actions">
                <button class="action-btn view-btn" title="Посмотреть пароль" data-id="${item.id}">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="action-btn edit-btn" title="Редактировать" data-id="${item.id}">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="action-btn delete-btn" title="Удалить" data-id="${item.id}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;

        // Назначаем обработчики через делегирование событий
        list.appendChild(div);
    }

    // Обновляем делегирование событий
    updateEventDelegation();
}

// Обновление делегирования событий
function updateEventDelegation() {
    const list = document.getElementById('passwords-list');
    
    // Удаляем старые обработчики
    list.removeEventListener('click', handlePasswordActions);
    
    // Добавляем новый обработчик
    list.addEventListener('click', handlePasswordActions);
}

// Обработчик действий с паролями
function handlePasswordActions(event) {
    const target = event.target;
    const button = target.closest('.action-btn');
    
    if (!button) return;
    
    const passwordId = button.dataset.id;
    const password = currentPasswords.find(p => p.id == passwordId);
    
    if (!password) {
        console.error('Password not found:', passwordId);
        tg.showAlert('Пароль не найден');
        return;
    }
    
    if (button.classList.contains('view-btn')) {
        showPassword(passwordId);
    } else if (button.classList.contains('edit-btn')) {
        editPassword(passwordId);
    } else if (button.classList.contains('delete-btn')) {
        confirmDelete(passwordId);
    }
}

// Показать пароль
async function showPassword(id) {
    const password = currentPasswords.find(p => p.id == id);
    if (!password) {
        tg.showAlert('Пароль не найден');
        return;
    }

    try {
        const decryptedPassword = await decryptPassword(
            password.encrypted_password,
            password.iv
        );

        document.getElementById('modal-service').textContent = password.service_name;
        document.getElementById('modal-login').value = password.login;
        document.getElementById('modal-password').value = decryptedPassword;
        document.getElementById('password-modal').dataset.id = id;

        // Устанавливаем поля только для чтения
        document.getElementById('modal-login').readOnly = true;
        document.getElementById('modal-password').readOnly = true;

        // Скрываем кнопку редактирования в режиме просмотра
        document.getElementById('modal-edit-btn').classList.remove('hidden');
        document.getElementById('modal-save-btn').classList.add('hidden');
        document.getElementById('modal-cancel-btn').classList.add('hidden');

        document.getElementById('password-modal').classList.remove('hidden');

    } catch (error) {
        console.error('❌ Error showing password:', error);
        tg.showAlert('Ошибка при загрузке пароля');
    }
}

// Редактировать пароль
async function editPassword(id) {
    const password = currentPasswords.find(p => p.id == id);
    if (!password) {
        tg.showAlert('Пароль не найден');
        return;
    }

    try {
        const decryptedPassword = await decryptPassword(
            password.encrypted_password,
            password.iv
        );

        document.getElementById('modal-service').textContent = 'Редактирование пароля: ' + password.service_name;
        document.getElementById('modal-login').value = password.login;
        document.getElementById('modal-password').value = decryptedPassword;
        document.getElementById('password-modal').dataset.id = id;

        // Разрешаем редактирование полей
        document.getElementById('modal-login').readOnly = false;
        document.getElementById('modal-password').readOnly = false;

        // Показываем кнопки редактирования
        document.getElementById('modal-edit-btn').classList.add('hidden');
        document.getElementById('modal-save-btn').classList.remove('hidden');
        document.getElementById('modal-cancel-btn').classList.remove('hidden');

        isEditMode = true;
        editPasswordId = id;

        document.getElementById('password-modal').classList.remove('hidden');

    } catch (error) {
        console.error('❌ Error editing password:', error);
        tg.showAlert('Ошибка при загрузке пароля');
    }
}

// Сохранить изменения пароля
async function savePassword() {
    const id = document.getElementById('password-modal').dataset.id;
    const newLogin = document.getElementById('modal-login').value.trim();
    const newPassword = document.getElementById('modal-password').value.trim();

    console.log('💾 Saving password changes:', { id, newLogin, newPasswordLength: newPassword.length });

    if (!newLogin || !newPassword) {
        tg.showAlert('Логин и пароль не могут быть пустыми!');
        return;
    }

    try {
        const encrypted = await encryptPassword(newPassword);
        console.log('🔒 Encrypted data ready for update');

        const response = await makeAuthenticatedRequest(`/api/passwords/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
                login: newLogin,
                encrypted_password: encrypted.encrypted,
                iv: encrypted.iv
            })
        });

        console.log('📨 Save response:', response);

        if (!response) {
            console.error('❌ No response from server');
            return;
        }

        const data = await response.json();
        console.log('📊 Save response data:', data);

        if (data.success) {
            tg.showAlert('✅ Пароль обновлен!');
            closeModal();
            await loadPasswords();

            // Вибрация
            if (tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred('medium');
            }
        } else {
            console.error('❌ Server error:', data);
            tg.showAlert(data.message || 'Ошибка при обновлении пароля');
        }

    } catch (error) {
        console.error('❌ Error saving password:', error);
        tg.showAlert('Ошибка при сохранении: ' + error.message);
    }
}

// Отменить редактирование
function cancelEdit() {
    const id = document.getElementById('password-modal').dataset.id;
    showPassword(id); // Возвращаемся в режим просмотра
}

// Добавить пароль
async function addPassword() {
    const serviceName = document.getElementById('service-name').value.trim();
    const login = document.getElementById('login').value.trim();
    const password = document.getElementById('password').value.trim();

    console.log('➕ Adding password:', { serviceName, login, passwordLength: password.length });

    if (!serviceName || !login || !password) {
        tg.showAlert('Заполните все поля!');
        return;
    }

    try {
        console.log('🔒 Encrypting password...');
        const encrypted = await encryptPassword(password);
        console.log('✅ Password encrypted');

        console.log('📤 Sending to server...');
        const response = await makeAuthenticatedRequest('/api/passwords', {
            method: 'POST',
            body: JSON.stringify({
                service_name: serviceName,
                login: login,
                encrypted_password: encrypted.encrypted,
                iv: encrypted.iv
            })
        });

        console.log('📨 Server response:', response);

        if (!response) {
            console.error('❌ No response from server');
            tg.showAlert('Нет ответа от сервера');
            return;
        }

        const data = await response.json();
        console.log('📊 Response data:', data);

        if (data.success) {
            // Очищаем форму
            document.getElementById('service-name').value = '';
            document.getElementById('login').value = '';
            document.getElementById('password').value = '';
            document.getElementById('password').type = 'password';
            document.querySelector('#toggle-password i').className = 'fas fa-eye';

            // Обновляем список
            await loadPasswords();

            tg.showAlert('✅ Пароль успешно сохранен!');

            // Вибрация
            if (tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred('soft');
            }
            
            console.log('✅ Password added successfully');
        } else {
            console.error('❌ Server returned error:', data);
            tg.showAlert(data.message || 'Ошибка при сохранении пароля');
        }

    } catch (error) {
        console.error('❌ Error adding password:', error);
        tg.showAlert('❌ Ошибка при сохранении: ' + error.message);
    }
}

// Генерация пароля
function generatePassword() {
    const length = 12;
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "";

    for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    document.getElementById('password').value = password;
    document.getElementById('password').type = 'text';
    document.querySelector('#toggle-password i').className = 'fas fa-eye-slash';
}

// Подтверждение удаления
async function confirmDelete(id) {
    const password = currentPasswords.find(p => p.id == id);
    if (!password) {
        tg.showAlert('Пароль не найден');
        return;
    }

    const confirmMessage = `Удалить пароль для ${password.service_name} (${password.login})?`;
    
    if (tg.showConfirm && typeof tg.showConfirm === 'function') {
        tg.showConfirm(confirmMessage, function(result) {
            if (result) {
                deletePasswordById(id);
            }
        });
    } else if (confirm(confirmMessage)) {
        await deletePasswordById(id);
    }
}

// Удалить пароль по ID
async function deletePasswordById(id) {
    try {
        console.log('🗑️ Deleting password ID:', id);
        const response = await makeAuthenticatedRequest(`/api/passwords/${id}`, {
            method: 'DELETE'
        });
        
        if (!response) return;
        
        const data = await response.json();
        console.log('Delete response:', data);
        
        if (data && data.success) {
            tg.showAlert('✅ Пароль удален');
            await loadPasswords(); // Перезагружаем список
        } else {
            tg.showAlert(data?.message || 'Не удалось удалить пароль');
        }
    } catch (error) {
        console.error('Error deleting password:', error);
        tg.showAlert('Ошибка при удалении: ' + error.message);
    }
}

// Удалить пароль из модального окна
async function deletePassword() {
    const id = document.getElementById('password-modal').dataset.id;
    await deletePasswordById(id);
    closeModal();
}

// Закрыть модальное окно
function closeModal() {
    document.getElementById('password-modal').classList.add('hidden');
    document.getElementById('modal-password').type = 'password';
    const toggleIcon = document.querySelector('.modal-field .toggle-password i');
    if (toggleIcon) {
        toggleIcon.className = 'fas fa-eye';
    }
    document.getElementById('modal-login').readOnly = true;
    document.getElementById('modal-password').readOnly = true;
    isEditMode = false;
    editPasswordId = null;
}

// Переключить видимость пароля в модальном окне
function toggleModalPassword() {
    const input = document.getElementById('modal-password');
    const icon = event.target.closest('button').querySelector('i');

    if (input.type === 'password') {
        input.type = 'text';
        icon.className = 'fas fa-eye-slash';
    } else {
        input.type = 'password';
        icon.className = 'fas fa-eye';
    }
}

// Копировать в буфер обмена
async function copyToClipboard(inputId) {
    const input = document.getElementById(inputId);
    input.select();

    try {
        await navigator.clipboard.writeText(input.value);
        tg.showAlert('✅ Скопировано!');

        if (tg.HapticFeedback) {
            tg.HapticFeedback.impactOccurred('light');
        }
    } catch (err) {
        input.select();
        document.execCommand('copy');
        tg.showAlert('✅ Скопировано!');
    }
}

// Обновить статистику
function updateStats() {
    document.getElementById('total-passwords').textContent = currentPasswords.length;

    if (currentPasswords.length > 0) {
        const last = currentPasswords[0];
        document.getElementById('last-added').textContent =
            last.service_name.length > 15 ?
                last.service_name.substring(0, 15) + '...' :
                last.service_name;
    } else {
        document.getElementById('last-added').textContent = '-';
    }
}

// Экранирование HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Инициализация обработчиков
function initEventHandlers() {
    console.log('🔧 Initializing event handlers...');
    
    // Переключение видимости пароля
    document.getElementById('toggle-password').addEventListener('click', function() {
        const input = document.getElementById('password');
        const icon = this.querySelector('i');

        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'fas fa-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'fas fa-eye';
        }
    });

    // Добавление по Enter
    document.getElementById('password').addEventListener('keyup', function(e) {
        if (e.key === 'Enter') {
            addPassword();
        }
    });

    // Закрытие модального окна
    document.getElementById('password-modal').addEventListener('click', function(e) {
        if (e.target === this) {
            closeModal();
        }
    });

    // Закрытие по ESC
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeModal();
        }
    });
    
    console.log('✅ Event handlers initialized');
}

// Глобальные функции
window.addPassword = addPassword;
window.generatePassword = generatePassword;
window.showPassword = showPassword;
window.editPassword = editPassword;
window.savePassword = savePassword;
window.cancelEdit = cancelEdit;
window.deletePassword = deletePassword;
window.confirmDelete = confirmDelete;
window.closeModal = closeModal;
window.toggleModalPassword = toggleModalPassword;
window.copyToClipboard = copyToClipboard;
window.filterPasswords = function() {
    const search = document.getElementById('search').value.toLowerCase();
    const items = document.querySelectorAll('.password-item');

    items.forEach(item => {
        const serviceName = item.querySelector('.service-name').textContent.toLowerCase();
        const login = item.querySelector('.login').textContent.toLowerCase();

        if (serviceName.includes(search) || login.includes(search)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
    });
};

// Запуск приложения
document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 DOM loaded, initializing app...');
    console.log('🌐 Current URL:', window.location.href);
    console.log('🔧 User Agent:', navigator.userAgent);
    
    initEventHandlers();
    initApp();
});
