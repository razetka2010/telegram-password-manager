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

// Конфигурация PostgreSQL - ВАРИАНТ 1
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://password_user:maxkW80zJSKEGz1wr7N8B4Mbk0RYcGT@dpg-d5d6bb4hg0e473f61pkg-a.frankfurt-postgres.render.com/telegram-password.db',
    ssl: {
        rejectUnauthorized: false
    }
});

// Простая проверка здоровья БД
async function checkDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('✅ Connected to PostgreSQL database');
        const result = await client.query('SELECT NOW() as time, current_database() as db, version() as version');
        console.log(`📊 Database: ${result.rows[0].db}`);
        console.log(`⏰ Time: ${result.rows[0].time}`);
        console.log(`🔧 PostgreSQL Version: ${result.rows[0].version.split(' ')[1]}`);
        client.release();
    } catch (error) {
        console.error('❌ Database connection error:', error.message);
    }
}

// Простой health check без БД
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'Telegram Password Manager',
        version: '1.0.0',
        endpoints: {
            init: '/api/init-db',
            debug: '/api/debug-tables',
            auth: '/api/auth (POST)',
            passwords: '/api/passwords'
        }
    });
});

// API: Инициализация БД
app.get('/api/init-db', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        console.log('Creating users table...');
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

        console.log('Creating passwords table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS passwords (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                service_name VARCHAR(255) NOT NULL,
                login VARCHAR(255) NOT NULL,
                encrypted_password TEXT NOT NULL,
                iv VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP,
                deleted_at TIMESTAMP
            )
        `);

        console.log('Creating indexes...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_passwords_user_id ON passwords(user_id, deleted_at)
        `);

        res.json({ 
            success: true, 
            message: 'Database tables created successfully',
            tables: ['users', 'passwords']
        });
    } catch (error) {
        console.error('DB init error details:', {
            message: error.message,
            code: error.code,
            detail: error.detail
        });
        res.status(500).json({ 
            success: false, 
            message: 'Database initialization failed',
            error: error.message,
            code: error.code,
            detail: error.detail
        });
    } finally {
        if (client) client.release();
    }
});

// API: Аутентификация (упрощенная версия для теста)
app.post('/api/auth', async (req, res) => {
    let client;
    try {
        const { initData } = req.body;

        if (!initData) {
            return res.status(400).json({ success: false, message: 'No initData' });
        }

        // Для теста создаем фиктивного пользователя
        const testUser = {
            id: 123456789,
            first_name: 'Test',
            last_name: 'User',
            username: 'testuser'
        };

        client = await pool.connect();
        
        // Проверяем существование таблицы users
        try {
            await client.query('SELECT 1 FROM users LIMIT 1');
        } catch (tableError) {
            // Таблицы нет, создаем ее
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
        }

        const result = await client.query(
            `INSERT INTO users (telegram_id, username, first_name, last_name, last_login)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (telegram_id) DO UPDATE SET
             username = EXCLUDED.username,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             last_login = CURRENT_TIMESTAMP
             RETURNING id, telegram_id, username, first_name, last_name, created_at`,
            [testUser.id, testUser.username, testUser.first_name, testUser.last_name]
        );

        const sessionToken = Buffer.from(JSON.stringify({
            telegram_id: testUser.id,
            user_id: result.rows[0].id,
            iat: Date.now(),
            exp: Date.now() + (7 * 24 * 60 * 60 * 1000)
        })).toString('base64');

        res.json({
            success: true,
            user: {
                telegram: testUser,
                database: result.rows[0]
            },
            session_token: sessionToken,
            message: 'Test authentication successful'
        });

    } catch (error) {
        console.error('Auth error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// Простой тестовый endpoint без БД
app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        database: {
            configured: true,
            status: 'Connection needs to be tested via /api/init-db'
        }
    });
});

// Проверка существования таблиц
app.get('/api/debug-tables', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        const tablesResult = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

        // Проверяем структуру каждой таблицы
        const tablesInfo = [];
        for (const table of tablesResult.rows) {
            try {
                const columnsResult = await client.query(`
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = $1
                    ORDER BY ordinal_position
                `, [table.table_name]);
                
                tablesInfo.push({
                    name: table.table_name,
                    columns: columnsResult.rows,
                    column_count: columnsResult.rowCount
                });
            } catch (error) {
                tablesInfo.push({
                    name: table.table_name,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            database: 'telegram-password.db',
            tables: tablesInfo,
            total_tables: tablesInfo.length
        });
    } catch (error) {
        console.error('Debug tables error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            code: error.code
        });
    } finally {
        if (client) client.release();
    }
});

// Отдаем index.html для всех остальных маршрутов
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запускаем сервер
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Database: PostgreSQL`);
    console.log(`📊 Health check: https://telegram-password-manager-1.onrender.com/api/health`);
    console.log(`🗄️  Init DB: https://telegram-password-manager-1.onrender.com/api/init-db`);
    console.log(`🔍 Debug tables: https://telegram-password-manager-1.onrender.com/api/debug-tables`);
    console.log(`🧪 Test endpoint: https://telegram-password-manager-1.onrender.com/api/test`);
    
    // Проверяем подключение
    console.log('🔄 Testing database connection...');
    await checkDatabaseConnection();
});
