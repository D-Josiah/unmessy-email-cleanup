// Simple health check endpoint to verify the API is running
export default async function handler(req, res) {
    try {
      // Check if Redis is connected
      const redisStatus = { connected: false };
      
      try {
        // Import Redis from config
        const { Redis } = await import('@upstash/redis');
        
        // Create connection using environment variables
        const redis = new Redis({
          url: process.env.UPSTASH_REDIS_URL || '',
          token: process.env.UPSTASH_REDIS_TOKEN || ''
        });
        
        // Ping Redis to verify connection
        await redis.ping();
        redisStatus.connected = true;
      } catch (redisError) {
        redisStatus.error = redisError.message;
      }
      
      // Return health information
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'production',
        redis: redisStatus,
        version: process.env.npm_package_version || '1.0.0'
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