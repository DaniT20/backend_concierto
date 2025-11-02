import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ExcelQrModule } from './excel-qr/excel-qr.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }),
    ExcelQrModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
