import { Test, TestingModule } from '@nestjs/testing';
import { ExcelQrController } from './excel-qr.controller';

describe('ExcelQrController', () => {
  let controller: ExcelQrController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExcelQrController],
    }).compile();

    controller = module.get<ExcelQrController>(ExcelQrController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
