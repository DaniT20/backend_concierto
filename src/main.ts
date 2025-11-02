import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS si lo necesitas
  app.enableCors({ origin: true });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  // En Render usa 0.0.0.0 para exponer correctamente
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 Server listening on http://0.0.0.0:${port}`);
}
bootstrap();
