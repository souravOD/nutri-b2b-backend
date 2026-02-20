import { queue } from '../lib/queue.js';
import { processIngestionJob } from './ingestion.js';
import type { QueueJob } from '../lib/queue.js';

export class QueueProcessor {
  private running = false;

  async start(): Promise<void> {
    if (this.running) {
      console.log('Queue processor already running');
      return;
    }

    this.running = true;
    console.log('Starting queue processor...');

    await queue.start(this.processJob.bind(this));
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    console.log('Stopping queue processor...');
    this.running = false;
    await queue.stop();
  }

  private async processJob(job: QueueJob): Promise<void> {
    console.log(`Processing job ${job.id}: ${job.mode} for vendor ${job.vendorId}`);

    try {
      switch (job.mode) {
        case 'products':
        case 'customers':
          await processIngestionJob(job);
          break;
        
        case 'api_sync':
          await this.processApiSync(job);
          break;
        
        default:
          throw new Error(`Unknown job mode: ${job.mode}`);
      }
    } catch (error) {
      console.error(`Job ${job.id} failed:`, error);
      throw error;
    }
  }

  private async processApiSync(job: QueueJob): Promise<void> {
    // API sync implementation would go here
    // This would handle rate-limited paged fetching from external APIs
    console.log(`API sync job ${job.id} - not yet implemented`);
  }
}

// Global queue processor instance
export const queueProcessor = new QueueProcessor();

// Auto-start in production only when explicitly enabled.
if (
  process.env.NODE_ENV === 'production' &&
  process.env.B2B_ENABLE_JOBS === '1' &&
  process.env.START_QUEUE === '1'
) {
  queueProcessor.start().catch(console.error);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await queueProcessor.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await queueProcessor.stop();
  process.exit(0);
});
