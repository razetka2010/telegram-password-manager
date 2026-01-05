const fs = require('fs');
const path = require('path');
const { format } = require('date-fns');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, 'logs');
        this.ensureLogDirectory();
        
        // Уровни логирования
        this.levels = {
            ERROR: 'ERROR',
            WARN: 'WARN', 
            INFO: 'INFO',
            DEBUG: 'DEBUG'
        };
    }
    
    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }
    
    getCurrentDate() {
        return format(new Date(), 'yyyy-MM-dd');
    }
    
    getLogFileName(level) {
        const date = this.getCurrentDate();
        return path.join(this.logDir, `${date}_${level.toLowerCase()}.log`);
    }
    
    formatLogMessage(level, message, metadata = {}) {
        const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS');
        const ip = metadata.ip || 'N/A';
        const endpoint = metadata.endpoint || 'N/A';
        const userId = metadata.userId || 'N/A';
        const requestId = metadata.requestId || this.generateRequestId();
        
        let logLine = `[${timestamp}] [${level}] [${requestId}]`;
        logLine += ` [IP:${ip}] [Endpoint:${endpoint}]`;
        
        if (userId !== 'N/A') {
            logLine += ` [User:${userId}]`;
        }
        
        logLine += ` ${message}`;
        
        // Добавляем метаданные если есть
        if (Object.keys(metadata).length > 0) {
            const meta = JSON.stringify(metadata);
            logLine += ` | Metadata: ${meta}`;
        }
        
        return logLine;
    }
    
    generateRequestId() {
        return Math.random().toString(36).substring(2, 15) + 
               Math.random().toString(36).substring(2, 15);
    }
    
    writeToFile(level, message) {
        try {
            const logFile = this.getLogFileName(level);
            fs.appendFileSync(logFile, message + '\n', 'utf8');
            
            // Также пишем в консоль
            if (process.env.NODE_ENV !== 'production' || level === 'ERROR') {
                console.log(message);
            }
        } catch (error) {
            console.error('Failed to write log:', error.message);
        }
    }
    
    log(level, message, metadata = {}) {
        const logMessage = this.formatLogMessage(level, message, metadata);
        this.writeToFile(level, logMessage);
    }
    
    error(message, metadata = {}) {
        this.log(this.levels.ERROR, message, metadata);
    }
    
    warn(message, metadata = {}) {
        this.log(this.levels.WARN, message, metadata);
    }
    
    info(message, metadata = {}) {
        this.log(this.levels.INFO, message, metadata);
    }
    
    debug(message, metadata = {}) {
        if (process.env.NODE_ENV !== 'production') {
            this.log(this.levels.DEBUG, message, metadata);
        }
    }
    
    logDatabaseQuery(query, params, duration, success = true) {
        this.debug(`Database query: ${query}`, {
            type: 'database',
            query: query.substring(0, 200), // Ограничиваем длину
            params: JSON.stringify(params),
            duration: `${duration}ms`,
            success: success
        });
    }
    
    logApiRequest(req, res, duration) {
        const metadata = {
            ip: req.ip,
            endpoint: req.originalUrl,
            method: req.method,
            userAgent: req.get('user-agent'),
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            requestId: req.requestId
        };
        
        const level = res.statusCode >= 400 ? 'ERROR' : 'INFO';
        const message = `${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`;
        
        this.log(level, message, metadata);
    }
    
    // Получить логи за определенный период
    getLogs(date, level = 'all') {
        try {
            const logFiles = fs.readdirSync(this.logDir);
            const logs = [];
            
            for (const file of logFiles) {
                if (file.startsWith(date)) {
                    if (level === 'all' || file.includes(`_${level}.log`)) {
                        const filePath = path.join(this.logDir, file);
                        const content = fs.readFileSync(filePath, 'utf8');
                        logs.push({
                            file: file,
                            content: content.split('\n').filter(line => line.trim())
                        });
                    }
                }
            }
            
            return logs;
        } catch (error) {
            this.error(`Failed to read logs: ${error.message}`);
            return [];
        }
    }
    
    // Очистка старых логов (старше 30 дней)
    cleanupOldLogs(daysToKeep = 30) {
        try {
            const logFiles = fs.readdirSync(this.logDir);
            const now = new Date();
            const cutoffDate = new Date(now.setDate(now.getDate() - daysToKeep));
            
            for (const file of logFiles) {
                const filePath = path.join(this.logDir, file);
                const stats = fs.statSync(filePath);
                const fileDate = new Date(stats.mtime);
                
                if (fileDate < cutoffDate) {
                    fs.unlinkSync(filePath);
                    this.info(`Deleted old log file: ${file}`);
                }
            }
        } catch (error) {
            this.error(`Failed to cleanup logs: ${error.message}`);
        }
    }
}

// Экспортируем синглтон
module.exports = new Logger();
