import 'reflect-metadata';
import { Logger } from '@nestjs/common';

// Keep test output clean — the simulation logs every round transition.
Logger.overrideLogger(false);
