const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const CryptoJS = require('crypto-js');
const logger = require('./logger');
const { loggerMiddleware, errorLoggerMiddleware } = require('./middleware/loggerMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));
app.use(loggerMiddleware); // Добавляем логирование всех запросов

// === КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ===
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://telegram_app_user:ueor0ZTVM6WeBxBhkZpt1h0xTEdwyo5J@dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com/telegram_password_manager';

logger.info('Starting Telegram Password Manager server', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    databaseHost: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com'
});

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
});

// Обработчики событий pool
pool.on('connect', (client) => {
    logger.debug('Database client connected', {
        poolTotal: pool.totalCount,
        poolIdle: pool.idleCount
    });
});

pool.on('error', (err) => {
    logger.error('Database pool error', {
        error: err.message,
        code: err.code
    });
});

// Обертка для логирования запросов к БД
const loggedPool = {
    async query(text, params) {
        const start = Date.now();
        try {
            const result = await pool.query(text, params);
            const duration = Date.now() - start;
            
            logger.logDatabaseQuery(text, params, duration, true);
            
            return result;
        } catch (error) {
            const duration = Date.now() - start;
            logger.error('Database query failed', {
                query: text.substring(0, 200),
                params: JSON.stringify(params),
                duration: `${duration}ms`,
                error: error.message,
                code: error.code,
                detail: error.detail
            });
            throw error;
        }
    },
    
    async connect() {
        return pool.connect();
    }
};

// Проверка подключения к БД
async function initializeDatabase() {
    try {
        logger.info('Testing database connection...');
        const client = await loggedPool.connect();
        
        const result = await client.query('SELECT NOW() as time, version() as version');
        const dbInfo = result.rows[0];
        
        logger.info('Database connection successful', {
            host: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
            database: 'telegram_password_manager',
            postgresVersion: dbInfo.version.split(' ')[1],
            serverTime: dbInfo.time
        });
        
        client.release();
        
        // Проверяем и создаем таблицы если нужно
        await ensureTablesExist();
        
        return true;
    } catch (error) {
        logger.error('Database initialization failed', {
            error: error.message,
            code: error.code,
            detail: error.detail
        });
        return false;
    }
}

async function ensureTablesExist() {
    let client;
    try {
        client = await loggedPool.connect();
        
        // Проверяем таблицу users
        const usersCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'users'
            )
        `);
        
        if (!usersCheck.rows[0].exists) {
            logger.info('Creating users table...');
            await client.query(`
                CREATE TABLE users (
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
            logger.info('Users table created successfully');
        }
        
        // Проверяем таблицу passwords
        const passwordsCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'passwords'
            )
        `);
        
        if (!passwordsCheck.rows[0].exists) {
            logger.info('Creating passwords table...');
            await client.query(`
                CREATE TABLE passwords (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    service_name VARCHAR(255) NOT NULL,
                    login VARCHAR(255) NOT NULL,
                    encrypted_password TEXT NOT NULL,
                    iv VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    deleted_at TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            
            // Создаем индексы
            await client.query(`
                CREATE INDEX idx_users_telegram_id ON users(telegram_id)
            `);
            await client.query(`
                CREATE INDEX idx_passwords_user_id ON passwords(user_id, deleted_at)
            `);
            
            logger.info('Passwords table and indexes created successfully');
        }
        
        logger.info('Database tables verification completed');
        
    } catch (error) {
        logger.error('Failed to ensure tables exist', {
            error: error.message,
            code: error.code
        });
        throw error;
    } finally {
        if (client) client.release();
    }
}

// === API ENDPOINTS ===

// 1. Health check
app.get('/api/health', async (req, res) => {
    try {
        const client = await loggedPool.connect();
        const dbResult = await client.query('SELECT NOW() as time');
        client.release();
        
        logger.debug('Health check performed', { requestId: req.requestId });
        
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: { connected: true, time: dbResult.rows[0].time },
            service: 'Telegram Password Manager'
        });
    } catch (error) {
        logger.error('Health check failed', {
            requestId: req.requestId,
            error: error.message
        });
        
        res.json({
            status: 'error',
            timestamp: new Date().toISOString(),
            database: { connected: false, error: error.message },
            service: 'Telegram Password Manager'
        });
    }
});

// 2. Инициализация БД
app.get('/api/init-db', async (req, res) => {
    try {
        logger.info('Database initialization requested', { requestId: req.requestId });
        
        await ensureTablesExist();
        
        logger.info('Database initialization completed successfully', { requestId: req.requestId });
        
        res.json({
            success: true,
            message: 'Database tables initialized successfully',
            tables: ['users', 'passwords'],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Database initialization failed in API', {
            requestId: req.requestId,
            error: error.message,
            code: error.code
        });
        
        res.status(500).json({
            success: false,
            message: 'Database initialization failed',
            error: error.message
        });
    }
});

// 3. Отладочная информация
app.get('/api/debug', async (req, res) => {
    let client;
    try {
        logger.debug('Debug information requested', { requestId: req.requestId });
        
        client = await loggedPool.connect();
        
        const dbInfo = await client.query(`
            SELECT current_database() as name, current_user as "user", version() as version
        `);
        
        const tables = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        logger.debug('Debug information retrieved', {
            requestId: req.requestId,
            tablesCount: tables.rowCount
        });
        
        res.json({
            success: true,
            database: dbInfo.rows[0],
            tables: tables.rows,
            logLevel: process.env.LOG_LEVEL || 'INFO'
        });
    } catch (error) {
        logger.error('Failed to get debug information', {
            requestId: req.requestId,
            error: error.message
        });
        
        res.status(500).json({
            success: false,
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// 4. Аутентификация
app.post('/api/auth', async (req, res) => {
    let client;
    try {
        const { initData } = req.body;

        if (!initData) {
            logger.warn('Auth request without initData', { requestId: req.requestId });
            return res.status(400).json({ 
                success: false, 
                message: 'No initData provided' 
            });
        }

        // Парсим initData
        const params = new URLSearchParams(initData);
        const userParam = params.get('user');
        
        let telegramUser;
        if (userParam) {
            telegramUser = JSON.parse(userParam);
            logger.info('Auth request from Telegram user', {
                requestId: req.requestId,
                telegramId: telegramUser.id,
                username: telegramUser.username
            });
        } else {
            // Для теста
            telegramUser = {
                id: 123456789,
                first_name: 'Test',
                last_name: 'User',
                username: 'test_user',
                language_code: 'en'
            };
            logger.debug('Auth request with test user', {
                requestId: req.requestId,
                telegramId: telegramUser.id
            });
        }

        client = await loggedPool.connect();

        // Сохраняем пользователя
        const userResult = await client.query(`
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

        const dbUser = userResult.rows[0];

        // Создаем токен
        const sessionToken = Buffer.from(JSON.stringify({
            telegram_id: telegramUser.id,
            user_id: dbUser.id,
            iat: Date.now(),
            exp: Date.now() + (7 * 24 * 60 * 60 * 1000)
        })).toString('base64');

        logger.info('User authenticated successfully', {
            requestId: req.requestId,
            telegramId: telegramUser.id,
            userId: dbUser.id,
            username: dbUser.username
        });

        res.json({
            success: true,
            user: {
                telegram: telegramUser,
                database: dbUser
            },
            session_token: sessionToken,
            permissions: {
                max_passwords: telegramUser.is_premium ? 1000 : 100
            }
        });

    } catch (error) {
        logger.error('Authentication failed', {
            requestId: req.requestId,
            error: error.message,
            code: error.code,
            stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
        });
        
        res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// 5. Получить пароли
app.get('/api/passwords', async (req, res) => {
    let client;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            logger.warn('Passwords request without token', { requestId: req.requestId });
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const token = authHeader.replace('Bearer ', '');
        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
            logger.debug('Token decoded successfully', {
                requestId: req.requestId,
                userId: tokenData.user_id
            });
        } catch (e) {
            logger.warn('Invalid token format', {
                requestId: req.requestId,
                token: token.substring(0, 50) + '...'
            });
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }

        client = await loggedPool.connect();
        const result = await client.query(`
            SELECT id, service_name, login, encrypted_password, iv, created_at, updated_at
            FROM passwords
            WHERE user_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC
        `, [tokenData.user_id]);

        logger.info('Passwords retrieved', {
            requestId: req.requestId,
            userId: tokenData.user_id,
            count: result.rowCount
        });

        res.json({
            success: true,
            passwords: result.rows,
            count: result.rowCount
        });

    } catch (error) {
        logger.error('Failed to get passwords', {
            requestId: req.requestId,
            error: error.message,
            code: error.code
        });
        
        res.status(500).json({ 
            success: false, 
            message: 'Failed to get passwords',
            error: error.message 
        });
    } finally {
        if (client) client.release();
    }
});

// 6. Добавить пароль
app.post('/api/passwords', async (req, res) => {
    let client;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            logger.warn('Add password request without token', { requestId: req.requestId });
            return res.status(401).json({ success: false, message: 'No token provided' });
        }

        const token = authHeader.replace('Bearer ', '');
        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const { service_name, login, encrypted_password, iv } = req.body;

        if (!service_name || !login || !encrypted_password || !iv) {
            logger.warn('Add password request with missing fields', {
                requestId: req.requestId,
                userId: tokenData.user_id,
                fields: { service_name: !!service_name, login: !!login, encrypted_password: !!encrypted_password, iv: !!iv }
            });
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        client = await loggedPool.connect();
        const result = await client.query(`
            INSERT INTO passwords (user_id, service_name, login, encrypted_password, iv)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at
        `, [tokenData.user_id, service_name, login, encrypted_password, iv]);

        logger.info('Password added successfully', {
            requestId: req.requestId,
            userId: tokenData.user_id,
            passwordId: result.rows[0].id,
            service: service_name
        });

        res.json({
            success: true,
            id: result.rows[0].id,
            created_at: result.rows[0].created_at,
            message: 'Password saved successfully'
        });

    } catch (error) {
        logger.error('Failed to add password', {
            requestId: req.requestId,
            error: error.message,
            code: error.code,
            userId: tokenData?.user_id
        });
        
        res.status(500).json({
            success: false,
            message: 'Failed to save password',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// 7. API для просмотра логов (только для админов)
app.get('/api/admin/logs', async (req, res) => {
    try {
        // Простая проверка авторизации (можно улучшить)
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        
        const date = req.query.date || new Date().toISOString().split('T')[0];
        const level = req.query.level || 'all';
        const limit = parseInt(req.query.limit) || 100;
        
        logger.info('Admin logs access requested', {
            requestId: req.requestId,
            date: date,
            level: level
        });
        
        const logs = logger.getLogs(date, level);
        
        // Ограничиваем количество записей
        const limitedLogs = logs.map(logFile => ({
            file: logFile.file,
            entries: logFile.content.slice(-limit)
        }));
        
        res.json({
            success: true,
            date: date,
            level: level,
            logs: limitedLogs,
            totalFiles: logs.length
        });
    } catch (error) {
        logger.error('Failed to retrieve logs', {
            requestId: req.requestId,
            error: error.message
        });
        
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve logs',
            error: error.message
        });
    }
});

// Статический контент
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware для обработки ошибок
app.use(errorLoggerMiddleware);

// Обработка несуществующих маршрутов
app.use((req, res) => {
    logger.warn('Route not found', {
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl,
        ip: req.ip
    });
    
    res.status(404).json({
        success: false,
        message: 'Route not found'
    });
});

// Запуск сервера
app.listen(PORT, async () => {
    logger.info('🚀 Server starting...', {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version
    });
    
    // Инициализация БД
    const dbInitialized = await initializeDatabase();
    
    if (dbInitialized) {
        logger.info('✅ Server started successfully', {
            port: PORT,
            url: `https://telegram-password-manager-1.onrender.com`,
            database: 'Connected and ready'
        });
    } else {
        logger.error('❌ Server started but database initialization failed');
    }
    
    // Запускаем очистку старых логов раз в день
    setInterval(() => {
        logger.cleanupOldLogs();
    }, 24 * 60 * 60 * 1000);
});
