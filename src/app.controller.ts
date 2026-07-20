import { Controller, Post, Body, Get } from '@nestjs/common';
import { AppService } from './app.module';

@Controller()
export class AppController {
  constructor(private readonly appService: any) {}

  @Get()
  getHello(): string {
    return 'Hello World!';
  }

  @Post('execute')
  execute(@Body() body: unknown): string {
    return 'Execute stub';
  }
}
