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

// В server.js измените конфигурацию pool:
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://password_user:mAzbKN3QzJSkEGziwr7WSB4NbkDRYcCT@dpg-d5dd0b4hg0os73f6lpkg-a.frankfurt-postgres.render.com:5432/telegram-password-db',
    ssl: true
});

// Проверка соединения с БД
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Connected to PostgreSQL database');
        release();
    }
});

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

// API: Аутентификация
app.post('/api/auth', async (req, res) => {
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
        // const botToken = process.env.BOT_TOKEN || 'ВАШ_ТОКЕН_БОТА';
        // if (!verifyTelegramHash(initData, botToken)) {
        //     return res.status(401).json({ success: false, message: 'Invalid signature' });
        // }

        const client = await pool.connect();
        try {
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

        } finally {
            client.release();
        }

    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            debug: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// API: Получить пароли
app.get('/api/passwords', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const client = await pool.connect();
        
        try {
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
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Get passwords error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// API: Добавить пароль
app.post('/api/passwords', async (req, res) => {
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

        const client = await pool.connect();
        try {
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
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Add password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// API: Обновить пароль
app.put('/api/passwords/:id', async (req, res) => {
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

        const client = await pool.connect();
        try {
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
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Update password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// API: Удалить пароль
app.delete('/api/passwords/:id', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const id = req.params.id;

        const client = await pool.connect();
        try {
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
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Delete password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// API: Инициализация БД (создание таблиц)
app.get('/api/init-db', async (req, res) => {
    const client = await pool.connect();
    try {
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
            message: error.message 
        });
    } finally {
        client.release();
    }
});

// API: Проверка работоспособности
app.get('/api/health', async (req, res) => {
    try {
        // Проверяем соединение с БД
        const client = await pool.connect();
        const dbResult = await client.query('SELECT NOW() as time');
        client.release();

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: {
                connected: true,
                time: dbResult.rows[0].time
            },
            service: 'Telegram Password Manager'
        });
    } catch (error) {
        res.json({
            status: 'error',
            timestamp: new Date().toISOString(),
            database: {
                connected: false,
                error: error.message
            },
            service: 'Telegram Password Manager'
        });
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
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🗄️  Init DB: http://localhost:${PORT}/api/init-db`);
});
