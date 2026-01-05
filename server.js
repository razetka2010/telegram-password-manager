const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const CryptoJS = require('crypto-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware с увеличенным лимитом
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// === КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ===
const pool = new Pool({
    user: process.env.DB_USER || 'telegram_app_user',
    password: process.env.DB_PASSWORD || 'ueor0ZTVM6WeBxBhkZpt1h0xTEdwyo5J',
    host: process.env.DB_HOST || 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'telegram_password_manager', // ИЗМЕНИТЕ ЗДЕСЬ
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
});

// Логирование всех запросов к БД для отладки
pool.on('connect', (client) => {
    console.log('🔌 New database client connected');
});

pool.on('error', (err) => {
    console.error('❌ Database pool error:', err.message);
});

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Проверка существования таблиц
async function checkTables() {
    let client;
    try {
        client = await pool.connect();
        const tables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        console.log('📊 Available tables:', tables.rows.map(t => t.table_name));
        return tables.rows;
    } catch (error) {
        console.error('Error checking tables:', error);
        return [];
    } finally {
        if (client) client.release();
    }
}

// Проверка структуры таблицы
async function checkTableStructure(tableName) {
    let client;
    try {
        client = await pool.connect();
        const columns = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = $1
            ORDER BY ordinal_position
        `, [tableName]);
        
        console.log(`📋 Table ${tableName} structure:`, columns.rows);
        return columns.rows;
    } catch (error) {
        console.error(`Error checking table ${tableName}:`, error);
        return [];
    } finally {
        if (client) client.release();
    }
}

// === API ENDPOINTS ===

// 1. Health check
app.get('/api/health', async (req, res) => {
    try {
        const tables = await checkTables();
        
        res.json({
            status: 'ok',
            service: 'Telegram Password Manager',
            timestamp: new Date().toISOString(),
            database: {
                connected: true,
                tables: tables.map(t => t.table_name),
                table_count: tables.length
            }
        });
    } catch (error) {
        res.json({
            status: 'partial',
            message: 'Service running but database check failed',
            error: error.message
        });
    }
});

// 2. Отладочная информация
app.get('/api/debug', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        // Проверяем структуру таблиц
        const usersColumns = await checkTableStructure('users');
        const passwordsColumns = await checkTableStructure('passwords');
        
        // Проверяем количество записей
        const usersCount = await client.query('SELECT COUNT(*) FROM users');
        const passwordsCount = await client.query('SELECT COUNT(*) FROM passwords WHERE deleted_at IS NULL');
        
        res.json({
            success: true,
            tables: {
                users: {
                    columns: usersColumns,
                    row_count: parseInt(usersCount.rows[0].count)
                },
                passwords: {
                    columns: passwordsColumns,
                    row_count: parseInt(passwordsCount.rows[0].count)
                }
            }
        });
    } catch (error) {
        console.error('Debug endpoint error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            suggestion: 'Run /api/fix-tables to ensure tables exist'
        });
    } finally {
        if (client) client.release();
    }
});

// 3. Исправление таблиц (если нужно)
app.get('/api/fix-tables', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        // Проверяем существование таблиц
        const tablesExist = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN ('users', 'passwords')
        `);
        
        const existingTables = tablesExist.rows.map(row => row.table_name);
        console.log('Existing tables:', existingTables);
        
        const operations = [];
        
        // Создаем таблицу users если ее нет
        if (!existingTables.includes('users')) {
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
            operations.push('Created users table');
            console.log('✅ Created users table');
        }
        
        // Создаем таблицу passwords если ее нет
        if (!existingTables.includes('passwords')) {
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
                    deleted_at TIMESTAMP
                )
            `);
            operations.push('Created passwords table');
            console.log('✅ Created passwords table');
        }
        
        // Создаем индексы
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_passwords_user_id ON passwords(user_id, deleted_at)
        `);
        
        operations.push('Created indexes');
        
        res.json({
            success: true,
            message: 'Tables fixed successfully',
            operations: operations,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Fix tables error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fix tables',
            error: error.message,
            detail: error.detail
        });
    } finally {
        if (client) client.release();
    }
});

// 4. Аутентификация (упрощенная версия)
app.post('/api/auth', async (req, res) => {
    let client;
    try {
        console.log('🔑 Auth request received:', {
            body: req.body,
            hasInitData: !!req.body.initData
        });
        
        const { initData } = req.body;

        if (!initData) {
            console.warn('Auth failed: No initData provided');
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
            try {
                telegramUser = JSON.parse(userParam);
                console.log('👤 Parsed Telegram user:', telegramUser);
            } catch (parseError) {
                console.error('Failed to parse user data:', parseError);
                return res.status(400).json({
                    success: false,
                    message: 'Invalid user data format'
                });
            }
        } else {
            // Тестовый пользователь
            telegramUser = {
                id: Math.floor(Math.random() * 1000000000),
                first_name: 'Test',
                last_name: 'User',
                username: 'testuser_' + Date.now(),
                language_code: 'en',
                is_premium: false
            };
            console.log('👤 Using test user:', telegramUser);
        }

        client = await pool.connect();
        
        console.log('💾 Saving user to database...');
        const userResult = await client.query(`
            INSERT INTO users (telegram_id, username, first_name, last_name, language_code, is_premium, last_login)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (telegram_id) DO UPDATE SET
                username = EXCLUDED.username,
                first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name,
                language_code = EXCLUDED.language_code,
                is_premium = EXCLUDED.is_premium,
                last_login = CURRENT_TIMESTAMP
            RETURNING id, telegram_id, username, first_name, last_name, created_at
        `, [
            telegramUser.id,
            telegramUser.username || null,
            telegramUser.first_name || '',
            telegramUser.last_name || '',
            telegramUser.language_code || 'en',
            telegramUser.is_premium || false
        ]);

        const dbUser = userResult.rows[0];
        console.log('✅ User saved:', dbUser);

        // Создаем токен сессии
        const sessionToken = Buffer.from(JSON.stringify({
            telegram_id: telegramUser.id,
            user_id: dbUser.id,
            iat: Date.now(),
            exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 дней
        })).toString('base64');

        console.log('🎫 Session token created');

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
        console.error('❌ Auth error details:', {
            message: error.message,
            code: error.code,
            detail: error.detail,
            stack: error.stack
        });
        
        res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message,
            code: error.code,
            suggestion: 'Check if database tables exist (run /api/debug)'
        });
    } finally {
        if (client) {
            client.release();
            console.log('🔌 Database client released');
        }
    }
});

// 5. Добавить пароль (с подробной отладкой)
app.post('/api/passwords', async (req, res) => {
    let client;
    try {
        console.log('📝 Add password request received');
        console.log('📦 Request headers:', req.headers);
        console.log('📦 Request body:', req.body);
        
        // Проверяем авторизацию
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.warn('❌ No authorization header');
            return res.status(401).json({ 
                success: false, 
                message: 'No authorization token provided' 
            });
        }

        const token = authHeader.replace('Bearer ', '');
        console.log('🔑 Token received:', token.substring(0, 20) + '...');
        
        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
            console.log('🔓 Token decoded:', tokenData);
        } catch (e) {
            console.error('❌ Failed to decode token:', e.message);
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid token format' 
            });
        }

        if (!tokenData.user_id) {
            console.error('❌ Token missing user_id');
            return res.status(401).json({ 
                success: false, 
                message: 'Invalid token data' 
            });
        }

        // Проверяем данные
        const { service_name, login, encrypted_password, iv } = req.body;
        console.log('📋 Password data:', { 
            service_name, 
            login, 
            encrypted_password_length: encrypted_password?.length,
            iv_length: iv?.length 
        });

        if (!service_name || !login || !encrypted_password || !iv) {
            console.error('❌ Missing required fields:', {
                has_service: !!service_name,
                has_login: !!login,
                has_encrypted: !!encrypted_password,
                has_iv: !!iv
            });
            return res.status(400).json({
                success: false,
                message: 'Missing required fields',
                required: ['service_name', 'login', 'encrypted_password', 'iv'],
                received: {
                    service_name: !!service_name,
                    login: !!login,
                    encrypted_password: !!encrypted_password,
                    iv: !!iv
                }
            });
        }

        // Проверяем пользователя
        client = await pool.connect();
        console.log('🔍 Checking if user exists...');
        const userCheck = await client.query(
            'SELECT id FROM users WHERE id = $1',
            [tokenData.user_id]
        );
        
        if (userCheck.rows.length === 0) {
            console.error('❌ User not found:', tokenData.user_id);
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        
        console.log('✅ User found:', userCheck.rows[0]);

        // Сохраняем пароль
        console.log('💾 Saving password to database...');
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

        const savedPassword = result.rows[0];
        console.log('✅ Password saved successfully:', savedPassword);

        res.json({
            success: true,
            id: savedPassword.id,
            created_at: savedPassword.created_at,
            message: 'Password saved successfully'
        });

    } catch (error) {
        console.error('❌ Add password error details:', {
            message: error.message,
            code: error.code,
            detail: error.detail,
            query: error.query,
            stack: error.stack
        });
        
        res.status(500).json({
            success: false,
            message: 'Failed to save password',
            error: error.message,
            code: error.code,
            detail: error.detail,
            suggestion: 'Check database connection and table structure'
        });
    } finally {
        if (client) {
            client.release();
            console.log('🔌 Database client released');
        }
    }
});

// 6. Получить пароли
app.get('/api/passwords', async (req, res) => {
    let client;
    try {
        console.log('📋 Get passwords request');
        
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const token = authHeader.replace('Bearer ', '');
        let tokenData;
        try {
            tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }

        client = await pool.connect();
        const result = await client.query(`
            SELECT id, service_name, login, encrypted_password, iv, 
                   created_at, updated_at
            FROM passwords 
            WHERE user_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC
        `, [tokenData.user_id]);

        console.log(`📊 Found ${result.rowCount} passwords for user ${tokenData.user_id}`);

        res.json({
            success: true,
            passwords: result.rows,
            count: result.rowCount
        });

    } catch (error) {
        console.error('Get passwords error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to get passwords',
            error: error.message 
        });
    } finally {
        if (client) client.release();
    }
});

// 7. Обновить пароль
app.put('/api/passwords/:id', async (req, res) => {
    let client;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const token = authHeader.replace('Bearer ', '');
        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const passwordId = req.params.id;
        const { login, encrypted_password, iv } = req.body;

        if (!login || !encrypted_password || !iv) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields' 
            });
        }

        client = await pool.connect();
        const result = await client.query(`
            UPDATE passwords 
            SET login = $1, encrypted_password = $2, iv = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4 AND user_id = $5 AND deleted_at IS NULL
            RETURNING id
        `, [login, encrypted_password, iv, passwordId, tokenData.user_id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Password not found' 
            });
        }

        res.json({
            success: true,
            message: 'Password updated successfully'
        });

    } catch (error) {
        console.error('Update password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to update password',
            error: error.message 
        });
    } finally {
        if (client) client.release();
    }
});

// 8. Удалить пароль
app.delete('/api/passwords/:id', async (req, res) => {
    let client;
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, message: 'No token' });
        }

        const token = authHeader.replace('Bearer ', '');
        const tokenData = JSON.parse(Buffer.from(token, 'base64').toString());
        const passwordId = req.params.id;

        client = await pool.connect();
        const result = await client.query(`
            UPDATE passwords 
            SET deleted_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            RETURNING id
        `, [passwordId, tokenData.user_id]);

        res.json({
            success: result.rowCount > 0,
            deleted: result.rowCount > 0,
            message: result.rowCount > 0 ? 'Password deleted' : 'Password not found'
        });

    } catch (error) {
        console.error('Delete password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to delete password',
            error: error.message 
        });
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
    
    // Проверяем таблицы при старте
    console.log('\n🔍 Checking database tables...');
    try {
        const tables = await checkTables();
        console.log(`📊 Found ${tables.length} tables:`, tables.map(t => t.table_name));
        
        // Проверяем структуру таблиц
        if (tables.length > 0) {
            for (const table of tables) {
                await checkTableStructure(table.table_name);
            }
        }
    } catch (error) {
        console.error('Error checking tables on startup:', error);
    }
    
    console.log('\n🔗 Available endpoints:');
    console.log(`   📊 Health: /api/health`);
    console.log(`   🔍 Debug: /api/debug`);
    console.log(`   🛠️  Fix tables: /api/fix-tables`);
    console.log(`   🔑 Auth: /api/auth (POST)`);
    console.log(`   📝 Add password: /api/passwords (POST)`);
    console.log(`   📋 Get passwords: /api/passwords (GET)`);
});
