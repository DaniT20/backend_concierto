import {
    BadRequestException,
    Body,
    Controller,
    Header,
    Post,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ExcelQrService } from './excel-qr.service';

@Controller('excel')
export class ExcelQrController {
    constructor(private readonly service: ExcelQrService) { }

    @Post('qr-to-firebase-and-api')
    @UseInterceptors(FileInterceptor('file'))
    @Header('Content-Type', 'application/json')
    async handle(@UploadedFile() file: any) {
        if (!file?.buffer) {
            throw new BadRequestException('Debes subir un archivo Excel (.xlsx) en el campo "file".');
        }
        return this.service.processExcelUpload(file.buffer);
    }
}
