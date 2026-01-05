const logger = require('../logger');

function loggerMiddleware(req, res, next) {
    // Генерируем уникальный ID для запроса
    req.requestId = logger.generateRequestId();
    
    // Сохраняем оригинальные методы
    const originalSend = res.send;
    const originalJson = res.json;
    
    const startTime = Date.now();
    
    // Переопределяем res.send для логирования
    res.send = function(body) {
        const duration = Date.now() - startTime;
        logger.logApiRequest(req, this, duration);
        return originalSend.call(this, body);
    };
    
    // Переопределяем res.json для логирования
    res.json = function(body) {
        const duration = Date.now() - startTime;
        logger.logApiRequest(req, this, duration);
        return originalJson.call(this, body);
    };
    
    // Логируем начало запроса
    logger.debug(`Request started: ${req.method} ${req.originalUrl}`, {
        ip: req.ip,
        endpoint: req.originalUrl,
        method: req.method,
        headers: req.headers,
        body: req.body,
        requestId: req.requestId
    });
    
    next();
}

// Middleware для логирования ошибок
function errorLoggerMiddleware(err, req, res, next) {
    logger.error(`Unhandled error: ${err.message}`, {
        ip: req.ip,
        endpoint: req.originalUrl,
        method: req.method,
        stack: err.stack,
        requestId: req.requestId,
        errorCode: err.code,
        errorDetails: err.details
    });
    
    next(err);
}

module.exports = {
    loggerMiddleware,
    errorLoggerMiddleware
};
