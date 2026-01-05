const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// === КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ===
// ВАЖНО: Используем правильное имя базы: telegram_password_manager (без _db в конце)
const pool = new Pool({
    user: 'telegram_app_user',
    password: 'ueor0ZTVM6WeBxBhkZpt1h0xTEdwyo5J',
    host: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
    port: 5432,
    database: 'telegram_password_manager', // ПРАВИЛЬНОЕ ИМЯ
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
});

console.log('🔧 Database config:', {
    host: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
    database: 'telegram_password_manager',
    user: 'telegram_app_user'
});

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Создание таблиц если они не существуют
async function createTablesIfNotExist() {
    let client;
    try {
        client = await pool.connect();
        
        // Таблица users
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                language_code VARCHAR(10),
                is_premium BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP
            )
        `);
        
        // Таблица passwords
        await client.query(`
            CREATE TABLE IF NOT EXISTS passwords (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                service_name VARCHAR(255) NOT NULL,
                login VARCHAR(255) NOT NULL,
                encrypted_password TEXT NOT NULL,
                iv VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                deleted_at TIMESTAMP
            )
        `);
        
        // Индексы
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_passwords_user_id ON passwords(user_id, deleted_at)
        `);
        
        console.log('✅ Tables created/verified');
        return true;
    } catch (error) {
        console.error('❌ Error creating tables:', error.message);
        return false;
    } finally {
        if (client) client.release();
    }
}

// Проверка подключения
async function testConnection() {
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT current_database() as db, version() as version');
        client.release();
        
        console.log('✅ Database connected:', result.rows[0]);
        return { connected: true, ...result.rows[0] };
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return { connected: false, error: error.message };
    }
}

// === API ENDPOINTS ===

// 1. Health check
app.get('/api/health', async (req, res) => {
    try {
        const dbTest = await testConnection();
        const tablesOk = await createTablesIfNotExist();
        
        res.json({
            status: 'ok',
            service: 'Telegram Password Manager',
            timestamp: new Date().toISOString(),
            database: dbTest,
            tables: tablesOk ? 'ready' : 'error'
        });
    } catch (error) {
        res.json({
            status: 'partial',
            message: 'Service running',
            error: error.message
        });
    }
});

// 2. Аутентификация (с тестовым режимом)
app.post('/api/auth', async (req, res) => {
    let client;
    try {
        const { initData } = req.body;
        
        // Если нет initData, создаем тестового пользователя
        let telegramUser;
        if (initData && initData.trim()) {
            try {
                const params = new URLSearchParams(initData);
                const userParam = params.get('user');
                if (userParam) {
                    telegramUser = JSON.parse(userParam);
                }
            } catch (e) {
                console.warn('Failed to parse initData:', e.message);
            }
        }
        
        // Если все еще нет пользователя, создаем тестового
        if (!telegramUser) {
            telegramUser = {
                id: Math.floor(Math.random() * 1000000000),
                first_name: 'Test',
                last_name: 'User',
                username: 'testuser_' + Date.now(),
                language_code: 'en'
            };
            console.log('👤 Using test user for auth');
        }
        
        // Создаем таблицы если нужно
        await createTablesIfNotExist();
        
        client = await pool.connect();
        
        // Сохраняем пользователя
        const result = await client.query(`
            INSERT INTO users (telegram_id, username, first_name, last_name, language_code, last_login)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (telegram_id) DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                language_code = EXCLUDED.language_code,
                last_login = CURRENT_TIMESTAMP
            RETURNING id, telegram_id, username, first_name, last_name, created_at
        `, [
            telegramUser.id,
            telegramUser.username || null,
            telegramUser.first_name || '',
            telegramUser.last_name || '',
            telegramUser.language_code || 'en'
        ]);

        const dbUser = result.rows[0];

        // Создаем токен
        const sessionToken = Buffer.from(JSON.stringify({
            telegram_id: telegramUser.id,
            user_id: dbUser.id,
            timestamp: Date.now()
        })).toString('base64');

        res.json({
            success: true,
            user: {
                telegram: telegramUser,
                database: dbUser
            },
            session_token: sessionToken,
            message: 'Authentication successful'
        });

    } catch (error) {
        console.error('❌ Auth error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// 3. Добавить пароль
app.post('/api/passwords', async (req, res) => {
    let client;
    try {
        console.log('📝 Add password request');
        
        // Проверяем авторизацию
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No authorization token' });
        }

        const token = authHeader.replace('Bearer ', '');
        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Invalid token format' });
        }

        // Проверяем данные
        const { service_name, login, encrypted_password, iv } = req.body;
        if (!service_name || !login || !encrypted_password || !iv) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields',
                required: ['service_name', 'login', 'encrypted_password', 'iv']
            });
        }

        // Создаем таблицы если нужно
        await createTablesIfNotExist();
        
        client = await pool.connect();
        
        // Сохраняем пароль
        const result = await client.query(`
            INSERT INTO passwords (user_id, service_name, login, encrypted_password, iv)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at
        `, [
            tokenData.user_id,
            service_name.trim(),
            login.trim(),
            encrypted_password,
            iv
        ]);

        console.log('✅ Password saved successfully');

        res.json({
            success: true,
            id: result.rows[0].id,
            created_at: result.rows[0].created_at,
            message: 'Password saved successfully'
        });

    } catch (error) {
        console.error('❌ Add password error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save password',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// 4. Получить пароли
app.get('/api/passwords', async (req, res) => {
    let client;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No authorization token' });
        }

        const token = authHeader.replace('Bearer ', '');
        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        
        await createTablesIfNotExist();
        
        client = await pool.connect();
        const result = await client.query(`
            SELECT id, service_name, login, encrypted_password, iv, created_at, updated_at
            FROM passwords 
            WHERE user_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC
        `, [tokenData.user_id]);

        res.json({
            success: true,
            passwords: result.rows,
            count: result.rowCount
        });

    } catch (error) {
        console.error('Get passwords error:', error);
        res.status(500).json({ success: false, message: 'Failed to get passwords' });
    } finally {
        if (client) client.release();
    }
});

// 5. Отладочная информация
app.get('/api/debug', async (req, res) => {
    let client;
    try {
        await createTablesIfNotExist();
        
        client = await pool.connect();
        
        // Информация о БД
        const dbInfo = await client.query('SELECT current_database() as db, version() as version');
        
        // Таблицы
        const tables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        // Количество записей
        const tableInfo = [];
        for (const table of tables.rows) {
            try {
                const count = await client.query(`SELECT COUNT(*) FROM "${table.table_name}"`);
                tableInfo.push({
                    name: table.table_name,
                    count: parseInt(count.rows[0].count)
                });
            } catch (e) {
                tableInfo.push({
                    name: table.table_name,
                    error: e.message
                });
            }
        }

        res.json({
            success: true,
            database: dbInfo.rows[0],
            tables: tableInfo,
            server_time: new Date().toISOString()
        });

    } catch (error) {
        console.error('Debug error:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (client) client.release();
    }
});

// Статический контент
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск сервера
app.listen(PORT, async () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 External URL: https://telegram-password-manager-1.onrender.com`);
    
    // Проверяем подключение и создаем таблицы
    console.log('\n🔌 Testing database connection...');
    const dbTest = await testConnection();
    
    if (dbTest.connected) {
        console.log(`✅ Connected to database: ${dbTest.db}`);
        console.log(`🔧 PostgreSQL version: ${dbTest.version}`);
        
        console.log('🗄️ Creating tables if needed...');
        const tablesOk = await createTablesIfNotExist();
        console.log(tablesOk ? '✅ Tables ready' : '⚠️ Tables creation failed');
    } else {
        console.error('❌ Database connection failed!');
        console.log('💡 Please check database credentials and name');
    }
    
    console.log('\n🔗 Available endpoints:');
    console.log('   /api/health - Health check');
    console.log('   /api/debug - Debug information');
    console.log('   /api/auth (POST) - Authentication');
    console.log('   /api/passwords (GET/POST) - Passwords');
});
