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

// === КОНФИГУРАЦИЯ БАЗЫ ДАННЫХ ===
// Используем реальные данные из новой базы данных
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://telegram_app_user:ueor0ZTVM6WeBxBhkZpt1h0xTEdwyo5J@dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com/telegram_password_manager';

console.log('🔧 Database configuration:', {
    host: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
    database: 'telegram_password_manager',
    user: 'telegram_app_user',
    url_set: !!process.env.DATABASE_URL
});

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
});

// Глобальный обработчик ошибок подключения
pool.on('error', (err) => {
    console.error('❌ Unexpected database pool error:', err.message);
});

// Функция проверки подключения к БД
async function testDatabaseConnection() {
    let client;
    try {
        console.log('🔄 Attempting database connection...');
        client = await pool.connect();
        console.log('✅ Database: Connection established');
        
        const result = await client.query('SELECT NOW() as time, version() as version');
        console.log(`📅 Database time: ${result.rows[0].time}`);
        console.log(`🔧 PostgreSQL version: ${result.rows[0].version}`);
        
        return {
            connected: true,
            time: result.rows[0].time,
            version: result.rows[0].version
        };
    } catch (error) {
        console.error('❌ Database connection failed:', {
            message: error.message,
            code: error.code,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
        
        // Пробуем альтернативный формат подключения
        console.log('🔄 Trying alternative connection format...');
        try {
            const altPool = new Pool({
                user: 'telegram_app_user',
                password: 'ueor0ZTVM6WeBxBhkZpt1h0xTEdwyo5J',
                host: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
                port: 5432,
                database: 'telegram_password_manager',
                ssl: { rejectUnauthorized: false }
            });
            
            const altClient = await altPool.connect();
            console.log('✅ Alternative connection successful!');
            altClient.release();
            await altPool.end();
            
            return {
                connected: true,
                message: 'Connected via alternative method'
            };
        } catch (altError) {
            console.error('❌ Alternative connection also failed:', altError.message);
            return {
                connected: false,
                error: error.message,
                suggestion: 'Check database credentials and network connectivity'
            };
        }
    } finally {
        if (client) client.release();
    }
}

// === API ENDPOINTS ===

// 1. Health check - всегда работает
app.get('/api/health', async (req, res) => {
    try {
        const dbCheck = await testDatabaseConnection();
        
        res.json({
            status: 'ok',
            service: 'Telegram Password Manager',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
            database: {
                connected: dbCheck.connected,
                type: 'PostgreSQL',
                host: 'dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com',
                port: 5432
            },
            server: {
                node: process.version,
                environment: process.env.NODE_ENV || 'development',
                uptime: process.uptime()
            }
        });
    } catch (error) {
        res.json({
            status: 'running',
            message: 'Service is running but database check failed',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 2. Инициализация таблиц (основная функция)
app.get('/api/init-db', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        console.log('🗄️ Starting database initialization...');
        
        // Создаем таблицу users
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
        console.log('✅ Users table created/verified');

        // Создаем таблицу passwords
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
        console.log('✅ Passwords table created/verified');

        // Создаем индексы
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_passwords_user_id ON passwords(user_id, deleted_at)
        `);
        console.log('✅ Indexes created/verified');

        res.json({
            success: true,
            message: 'Database tables initialized successfully',
            tables: ['users', 'passwords'],
            timestamp: new Date().toISOString(),
            database: 'telegram_password_manager'
        });

    } catch (error) {
        console.error('❌ Database initialization error:', {
            message: error.message,
            code: error.code,
            detail: error.detail
        });
        
        res.status(500).json({
            success: false,
            message: 'Database initialization failed',
            error: error.message,
            code: error.code,
            suggestion: 'Check database permissions and connection'
        });
    } finally {
        if (client) {
            client.release();
            console.log('🔌 Database client released');
        }
    }
});

// 3. Информация о таблицах
app.get('/api/debug', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        
        // Информация о БД
        const dbInfo = await client.query(`
            SELECT 
                current_database() as name,
                current_user as "user",
                inet_server_addr() as host,
                inet_server_port() as port,
                version() as version
        `);

        // Список таблиц
        const tables = await client.query(`
            SELECT 
                table_name,
                (SELECT COUNT(*) FROM information_schema.columns 
                 WHERE table_name = t.table_name) as columns_count
            FROM information_schema.tables t
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);

        // Подробности о каждой таблице
        const tablesDetails = [];
        for (const table of tables.rows) {
            try {
                const columns = await client.query(`
                    SELECT column_name, data_type, is_nullable
                    FROM information_schema.columns
                    WHERE table_name = $1
                    ORDER BY ordinal_position
                `, [table.table_name]);
                
                const rowCount = await client.query(`SELECT COUNT(*) FROM "${table.table_name}"`);
                
                tablesDetails.push({
                    name: table.table_name,
                    columns: columns.rows,
                    row_count: parseInt(rowCount.rows[0].count)
                });
            } catch (e) {
                tablesDetails.push({
                    name: table.table_name,
                    error: e.message
                });
            }
        }

        res.json({
            success: true,
            database: dbInfo.rows[0],
            tables: tablesDetails,
            connection: {
                url: process.env.DATABASE_URL ? '***HIDDEN***' : 'Using hardcoded URL',
                status: 'connected'
            }
        });

    } catch (error) {
        console.error('Debug error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            database_url: DATABASE_URL.replace(/:[^:@]*@/, ':***@'),
            suggestion: 'Run /api/init-db first to create tables'
        });
    } finally {
        if (client) client.release();
    }
});

// 4. Тестовый эндпоинт для проверки работы
app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'Server is working correctly',
        timestamp: new Date().toISOString(),
        endpoints: [
            'GET /api/health - Health check',
            'GET /api/init-db - Initialize database',
            'GET /api/debug - Database information',
            'POST /api/auth - Authenticate user',
            'GET /api/passwords - Get user passwords',
            'POST /api/passwords - Add new password',
            'PUT /api/passwords/:id - Update password',
            'DELETE /api/passwords/:id - Delete password'
        ]
    });
});

// 5. Аутентификация
app.post('/api/auth', async (req, res) => {
    let client;
    try {
        const { initData } = req.body;

        if (!initData) {
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
        } else {
            // Для теста
            telegramUser = {
                id: 123456789,
                first_name: 'Test',
                last_name: 'User',
                username: 'test_user',
                language_code: 'en'
            };
        }

        client = await pool.connect();

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
        console.error('Auth error:', error);
        res.status(500).json({
            success: false,
            message: 'Authentication failed',
            error: error.message
        });
    } finally {
        if (client) client.release();
    }
});

// 6-9. Остальные эндпоинты (passwords, update, delete)...
// [Здесь остальной код из предыдущего сообщения - эндпоинты для работы с паролями]

// Статический контент
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Запуск сервера
app.listen(PORT, async () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📊 External URL: https://telegram-password-manager-1.onrender.com`);
    console.log(`🔧 Node.js version: ${process.version}`);
    
    // Тестируем подключение к БД
    console.log('\n🔌 Testing database connection to new database...');
    console.log(`📡 Host: dpg-d5dq2p75r7bs73c3sj9g-a.frankfurt-postgres.render.com`);
    console.log(`🗃️ Database: telegram_password_manager`);
    
    const dbResult = await testDatabaseConnection();
    
    if (dbResult.connected) {
        console.log('🎉 Database connection SUCCESSFUL!');
        console.log('✅ Application is ready to use');
    } else {
        console.error('❌ Database connection FAILED!');
        console.log('💡 Please check:');
        console.log('   1. Database status on Render.com');
        console.log('   2. Environment variable DATABASE_URL');
        console.log('   3. Network connectivity');
    }
    
    console.log('\n🔗 Available endpoints:');
    console.log(`   📊 Health: https://telegram-password-manager-1.onrender.com/api/health`);
    console.log(`   🗄️  Init DB: https://telegram-password-manager-1.onrender.com/api/init-db`);
    console.log(`   🔍 Debug: https://telegram-password-manager-1.onrender.com/api/debug`);
    console.log(`   🧪 Test: https://telegram-password-manager-1.onrender.com/api/test`);
});
