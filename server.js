const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Конфигурация PostgreSQL с правильными данными
const pool = new Pool({
    user: 'password_user',
    password: 'maxkW80zJSKEGz1wr7N8B4Mbk0RYcGT',
    host: 'dpg-d5d6bb4hg0e473f61pkg-a.frankfurt-postgres.render.com',
    port: 5432,
    database: 'telegram-password.db',
    ssl: {
        rejectUnauthorized: false
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

// Проверка соединения с БД
pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client:', err);
});

// Простая проверка здоровья БД
async function checkDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL database');
        const result = await client.query('SELECT NOW() as time, current_database() as db');
        console.log(`📊 Database: ${result.rows[0].db}, Time: ${result.rows[0].time}`);
        client.release();
    } catch (error) {
        console.error('❌ Database connection error:', error.message);
        console.error('❌ Full error:', error);
    }
}

// Проверяем подключение при старте
checkDatabaseConnection();

// Проверка подписи Telegram
function verifyTelegramHash(initData, botToken) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return false;

        params.delete('hash');
        const sortedParams = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = CryptoJS.HmacSHA256(botToken, 'WebAppData');
        const calculatedHash = CryptoJS.HmacSHA256(sortedParams, secretKey).toString(CryptoJS.enc.Hex);

        return calculatedHash === hash;
    } catch (error) {
        console.error('Hash verification error:', error);
        return false;
    }
}

// API: Проверка работоспособности (упрощенная версия без проверки БД)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'Telegram Password Manager',
        version: '1.0.0'
    });
});

// API: Инициализация БД (создание таблиц)
app.get('/api/init-db', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        // Создаем таблицу users
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);

        // Создаем таблицу passwords
        await client.query(`
            CREATE TABLE IF NOT EXISTS passwords (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                service_name VARCHAR(255) NOT NULL,
                login VARCHAR(255) NOT NULL,
                encrypted_password TEXT NOT NULL,
                iv VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP,
                deleted_at TIMESTAMP
            )
        `);

        // Создаем индексы
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_passwords_user_id ON passwords(user_id, deleted_at)
        `);

        res.json({ 
            success: true, 
            message: 'Database tables created successfully' 
        });
    } catch (error) {
        console.error('DB init error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message,
            code: error.code,
            detail: error.detail
        });
    } finally {
        if (client) client.release();
    }
});

// Отладочный API: Посмотреть таблицы
app.get('/api/debug-tables', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        // Получаем список всех таблиц
        const tablesResult = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

        res.json({
            success: true,
            tables: tablesResult.rows,
            total_tables: tablesResult.rowCount
        });
    } catch (error) {
        console.error('Debug tables error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            code: error.code
        });
    } finally {
        if (client) client.release();
    }
});

// API: Аутентификация
app.post('/api/auth', async (req, res) => {
    let client;
    try {
        const { initData } = req.body;

        if (!initData) {
            return res.status(400).json({ success: false, message: 'No initData' });
        }

        const params = new URLSearchParams(initData);
        const userParam = params.get('user');

        if (!userParam) {
            return res.status(400).json({ success: false, message: 'No user data' });
        }

        const user = JSON.parse(userParam);

        // Для продакшена включите проверку подписи
        // const botToken = process.env.BOT_TOKEN || '8538939071:AAHbnDlQVpaAIZ0Sv-76zzxhV-ZYWI7PP-4';
        // if (!verifyTelegramHash(initData, botToken)) {
        //     return res.status(401).json({ success: false, message: 'Invalid signature' });
        // }

        client = await pool.connect();
        
        // Создаем или обновляем пользователя
        const result = await client.query(
            `INSERT INTO users (telegram_id, username, first_name, last_name, last_login)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (telegram_id) DO UPDATE SET
             username = EXCLUDED.username,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             last_login = CURRENT_TIMESTAMP
             RETURNING id, telegram_id, username, first_name, last_name, created_at`,
            [user.id, user.username || null, user.first_name || '', user.last_name || '']
        );

        const sessionToken = Buffer.from(JSON.stringify({
            telegram_id: user.id,
            user_id: result.rows[0].id,
            iat: Date.now(),
            exp: Date.now() + (7 * 24 * 60 * 60 * 1000)
        })).toString('base64');

        res.json({
            success: true,
            user: {
                telegram: user,
                database: result.rows[0]
            },
            session_token: sessionToken
        });

    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message,
            code: error.code
        });
    } finally {
        if (client) client.release();
    }
});

// API: Получить пароли
app.get('/api/passwords', async (req, res) => {
    let client;
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        client = await pool.connect();
        
        const result = await client.query(
            `SELECT id, service_name, login, encrypted_password, iv, created_at, updated_at
             FROM passwords
             WHERE user_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [tokenData.user_id]
        );

        res.json({
            success: true,
            passwords: result.rows,
            count: result.rowCount
        });
    } catch (error) {
        console.error('Get passwords error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// API: Добавить пароль
app.post('/api/passwords', async (req, res) => {
    let client;
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const { service_name, login, encrypted_password, iv } = req.body;

        if (!service_name || !login || !encrypted_password || !iv) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        client = await pool.connect();
        const result = await client.query(
            `INSERT INTO passwords (user_id, service_name, login, encrypted_password, iv)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, created_at`,
            [tokenData.user_id, service_name, login, encrypted_password, iv]
        );

        res.json({
            success: true,
            id: result.rows[0].id,
            created_at: result.rows[0].created_at
        });
    } catch (error) {
        console.error('Add password error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// API: Обновить пароль
app.put('/api/passwords/:id', async (req, res) => {
    let client;
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const id = req.params.id;
        const { login, encrypted_password, iv } = req.body;

        if (!login || !encrypted_password || !iv) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        client = await pool.connect();
        const result = await client.query(
            `UPDATE passwords 
             SET login = $1, encrypted_password = $2, iv = $3, updated_at = CURRENT_TIMESTAMP
             WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL
             RETURNING id`,
            [login, encrypted_password, iv, id, tokenData.user_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Password not found or access denied' 
            });
        }

        res.json({
            success: true,
            updated: true,
            message: 'Password updated successfully'
        });
    } catch (error) {
        console.error('Update password error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// API: Удалить пароль
app.delete('/api/passwords/:id', async (req, res) => {
    let client;
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const id = req.params.id;

        client = await pool.connect();
        const result = await client.query(
            `UPDATE passwords SET deleted_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND user_id = $2
             RETURNING id`,
            [id, tokenData.user_id]
        );

        res.json({
            success: result.rowCount > 0,
            deleted: result.rowCount > 0
        });
    } catch (error) {
        console.error('Delete password error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    } finally {
        if (client) client.release();
    }
});

// Отдаем index.html для всех остальных маршрутов
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запускаем сервер
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Database: PostgreSQL`);
    console.log(`📊 Health check: https://telegram-password-manager-1.onrender.com/api/health`);
    console.log(`🗄️  Init DB: https://telegram-password-manager-1.onrender.com/api/init-db`);
    console.log(`🔍 Debug tables: https://telegram-password-manager-1.onrender.com/api/debug-tables`);
    
    // Проверяем подключение через 2 секунды после запуска
    setTimeout(() => {
        checkDatabaseConnection();
    }, 2000);
});
