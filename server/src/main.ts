import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { type AppConfig, ConfigError, parseConfig } from './config/config';

async function bootstrap(): Promise<void> {
    let config: AppConfig | 'help';
    try {
        config = parseConfig(process.argv.slice(2), process.env);
    } catch (err) {
        if (err instanceof ConfigError) {
            process.exit(1);
        }
        throw err;
    }
    if (config === 'help') {
        return;
    }

    const app = await NestFactory.create(AppModule.forRoot(config), {
        logger: config.verbose ? ['debug', 'log', 'warn', 'error'] : ['log', 'warn', 'error'],
    });
    app.useWebSocketAdapter(new WsAdapter(app));
    app.enableShutdownHooks();
    await app.listen(config.port);
}

void bootstrap();
