import { Module } from '@nestjs/common';
import { ExcelQrService } from './excel-qr.service';
import { ExcelQrController } from './excel-qr.controller';

@Module({
  providers: [ExcelQrService],
  controllers: [ExcelQrController]
})
export class ExcelQrModule {}
