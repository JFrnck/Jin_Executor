import type { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

export { ConfigModule } from './config.module';
export { EnvSchema, validateEnv, type Env } from './env.schema';

export type AppConfigService = ConfigService<Env, true>;
