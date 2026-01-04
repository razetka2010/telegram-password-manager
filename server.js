const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const mysql = require('mysql2/promise');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Конфигурация базы данных для Render
// Создадим отдельный сервис для MySQL на Render
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'password_manager',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Создаем пул соединений
let pool;
try {
    pool = mysql.createPool(dbConfig);
    console.log('✅ Database connection configured');
} catch (error) {
    console.error('❌ Database configuration error:', error);
}

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

        if (!pool) {
            return res.status(500).json({ success: false, message: 'Database not configured' });
        }

        const connection = await pool.getConnection();
        try {
            const [result] = await connection.execute(
                `INSERT INTO users (telegram_id, username, first_name, last_name)
                 VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                                          username = VALUES(username),
                                          first_name = VALUES(first_name),
                                          last_name = VALUES(last_name),
                                          last_login = CURRENT_TIMESTAMP`,
                [user.id, user.username || null, user.first_name || '', user.last_name || '']
            );

            const [rows] = await connection.execute(
                'SELECT id, telegram_id, username, first_name, last_name, created_at FROM users WHERE telegram_id = ?',
                [user.id]
            );

            const sessionToken = Buffer.from(JSON.stringify({
                telegram_id: user.id,
                user_id: rows[0].id,
                iat: Date.now(),
                exp: Date.now() + (7 * 24 * 60 * 60 * 1000)
            })).toString('base64');

            res.json({
                success: true,
                user: {
                    telegram: user,
                    database: rows[0]
                },
                session_token: sessionToken
            });

        } finally {
            connection.release();
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

        if (!pool) {
            return res.status(500).json({ success: false, message: 'Database not configured' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const connection = await pool.getConnection();

        try {
            const [rows] = await connection.execute(
                `SELECT id, service_name, login, encrypted_password, iv, created_at
                 FROM passwords
                 WHERE user_id = ? AND deleted_at IS NULL
                 ORDER BY created_at DESC`,
                [tokenData.user_id]
            );

            res.json({
                success: true,
                passwords: rows,
                count: rows.length
            });
        } finally {
            connection.release();
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

        if (!pool) {
            return res.status(500).json({ success: false, message: 'Database not configured' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const { service_name, login, encrypted_password, iv } = req.body;

        if (!service_name || !login || !encrypted_password || !iv) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        const connection = await pool.getConnection();
        try {
            const [result] = await connection.execute(
                `INSERT INTO passwords (user_id, service_name, login, encrypted_password, iv)
                 VALUES (?, ?, ?, ?, ?)`,
                [tokenData.user_id, service_name, login, encrypted_password, iv]
            );

            res.json({
                success: true,
                id: result.insertId,
                created_at: new Date().toISOString()
            });
        } finally {
            connection.release();
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

        if (!pool) {
            return res.status(500).json({ success: false, message: 'Database not configured' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const id = req.params.id;
        const { login, encrypted_password, iv } = req.body;

        if (!login || !encrypted_password || !iv) {
            return res.status(400).json({ success: false, message: 'Missing fields' });
        }

        const connection = await pool.getConnection();
        try {
            const [result] = await connection.execute(
                `UPDATE passwords 
                 SET login = ?, encrypted_password = ?, iv = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
                [login, encrypted_password, iv, id, tokenData.user_id]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Password not found or access denied'
                });
            }

            res.json({
                success: true,
                updated: true,
                message: 'Password updated successfully',
                updated_at: new Date().toISOString()
            });
        } finally {
            connection.release();
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

        if (!pool) {
            return res.status(500).json({ success: false, message: 'Database not configured' });
        }

        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const id = req.params.id;

        const connection = await pool.getConnection();
        try {
            const [result] = await connection.execute(
                `UPDATE passwords SET deleted_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND user_id = ?`,
                [id, tokenData.user_id]
            );

            res.json({
                success: result.affectedRows > 0,
                deleted: result.affectedRows > 0
            });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('Delete password error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// API: Инициализация БД (только для разработки)
app.get('/api/init-db', async (req, res) => {
    try {
        if (!pool) {
            return res.status(500).json({ success: false, message: 'Database not configured' });
        }

        const connection = await pool.getConnection();
        try {
            await connection.execute(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    telegram_id BIGINT UNIQUE NOT NULL,
                    username VARCHAR(255),
                    first_name VARCHAR(255),
                    last_name VARCHAR(255),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP NULL
                )
            `);

            await connection.execute(`
                CREATE TABLE IF NOT EXISTS passwords (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NOT NULL,
                    service_name VARCHAR(255) NOT NULL,
                    login VARCHAR(255) NOT NULL,
                    encrypted_password TEXT NOT NULL,
                    iv VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NULL,
                    deleted_at TIMESTAMP NULL,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);

            res.json({ success: true, message: 'Database initialized' });
        } finally {
            connection.release();
        }
    } catch (error) {
        console.error('DB init error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Проверка работоспособности
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'Telegram Password Manager'
    });
});

// Отдаем index.html для всех остальных маршрутов
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запускаем сервер
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
});