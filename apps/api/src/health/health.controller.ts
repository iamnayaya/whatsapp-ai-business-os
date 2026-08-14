import { Controller, Get, UseGuards } from '@nestjs/common';
import { HealthService } from './health.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('health')
@UseGuards(new RateLimitGuard({ limit: 30, windowMs: 60_000 }))
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check() {
    return this.health.check();
  }
}