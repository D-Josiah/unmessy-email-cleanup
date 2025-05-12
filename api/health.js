// Simple health check endpoint with enhanced Redis testing
export default async function handler(req, res) {
  try {
    // Check if Redis is connected with improved diagnostics
    const redisStatus = { 
      connected: false,
      tested: false,
      responseTime: null 
    };
    
    try {
      // Import Redis from config
      const { Redis } = await import('@upstash/redis');
      
      // Create connection using environment variables
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_URL || '',
        token: process.env.UPSTASH_REDIS_TOKEN || ''
      });
      
      // Time the Redis ping to diagnose performance
      const startTime = Date.now();
      
      // Set a timeout to ensure we don't hang
      const pingPromise = redis.ping();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis ping timeout')), 2000);
      });
      
      try {
        // Race between ping and timeout
        await Promise.race([pingPromise, timeoutPromise]);
        
        // Calculate response time
        const responseTime = Date.now() - startTime;
        
        redisStatus.connected = true;
        redisStatus.tested = true;
        redisStatus.responseTime = responseTime;
        
        // Add warning if response time is high
        if (responseTime > 500) {
          redisStatus.warning = 'Redis response time is high';
        }
      } catch (pingError) {
        redisStatus.tested = true;
        redisStatus.error = pingError.message;
        
        // Add specific error for timeout
        if (pingError.message === 'Redis ping timeout') {
          redisStatus.timeoutError = true;
        }
      }
    } catch (redisError) {
      redisStatus.error = redisError.message;
    }
    
    // Check ZeroBounce config including retry settings
    const zeroBounceStatus = {
      configured: !!process.env.ZERO_BOUNCE_API_KEY,
      enabled: process.env.USE_ZERO_BOUNCE === 'true',
      maxRetries: parseInt(process.env.ZERO_BOUNCE_MAX_RETRIES || '1', 10),
      timeouts: {
        initial: parseInt(process.env.ZERO_BOUNCE_TIMEOUT || '6000', 10),
        retry: parseInt(process.env.ZERO_BOUNCE_RETRY_TIMEOUT || '8000', 10)
      }
    };
    
    // Return health information
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production',
      redis: redisStatus,
      zeroBounce: zeroBounceStatus,
      redisEnabled: process.env.USE_REDIS === 'true',
      version: process.env.npm_package_version || '1.0.0',
      dateFormats: {
        example: {
          spelled: new Date().toLocaleString('en-US', { 
            weekday: 'long',
            year: 'numeric', 
            month: 'long', 
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            timeZoneName: 'short'
          }),
          epochMs: Date.now() // Milliseconds format example
        }
      }
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
}