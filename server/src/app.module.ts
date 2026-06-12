import { DynamicModule, Module } from '@nestjs/common';
import { AppConfig, CLOCK, CONFIG, makeClock } from './config/config';
import { FeedGateway } from './feed/feed.gateway';
import { RNG, Rng } from './rng/rng.provider';
import { SimulationService } from './simulation/simulation.service';

@Module({})
export class AppModule {
    static forRoot(config: AppConfig): DynamicModule {
        return {
            module: AppModule,
            providers: [
                { provide: CONFIG, useValue: config },
                { provide: RNG, useValue: new Rng(config.seed) },
                { provide: CLOCK, useValue: makeClock(config) },
                SimulationService,
                FeedGateway,
            ],
        };
    }
}
