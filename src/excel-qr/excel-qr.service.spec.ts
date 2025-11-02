import { Test, TestingModule } from '@nestjs/testing';
import { ExcelQrService } from './excel-qr.service';

describe('ExcelQrService', () => {
  let service: ExcelQrService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExcelQrService],
    }).compile();

    service = module.get<ExcelQrService>(ExcelQrService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
