import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as QRCode from 'qrcode';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { initFirebase } from '../firebase';
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import FormData = require('form-data');

/* ====== Cifrado (AES-256-GCM con PBKDF2) ====== */
const ITERATIONS = 100_000;
const KEYLEN = 32; // 256 bits
const DIGEST = 'sha256';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encryptForQr(plain: string, passphrase: string): string {
  if (!passphrase || passphrase.length < 12) {
    throw new Error('QR_SECRET_KEY no definido o muy corto. Define un secreto >= 12 chars.');
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);

  const key = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEYLEN, DIGEST);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ctAndTag = Buffer.concat([ciphertext, tag]);

  return `v1.${b64url(iv)}.${b64url(salt)}.${b64url(ctAndTag)}`;
}

/* ====== Helpers de normalización de encabezados ====== */
function normalizeHeader(h: string): string {
  return (h || '')
    .toString()
    .normalize('NFD')                // separa acentos
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .trim()
    .toLowerCase();
}

const REQUIRED_HEADERS = [
  'codigo',
  'nombres',
  'telefono',
  'denominacion', // tal como lo especificaste
  'estado',
  'numpases',
] as const;
type RequiredHeader = (typeof REQUIRED_HEADERS)[number];

@Injectable()
export class ExcelQrService {
  private readonly apiUrl = (process.env.API_TARGET_URL || '').trim();

  // Firebase
  private readonly app = initFirebase();
  private readonly bucket = this.app.storage().bucket();
  private readonly db = this.app.firestore();

  // Config QR
  private readonly passphrase = (process.env.QR_SECRET_KEY || '').trim();
  private readonly envTemplate = process.env.QR_TEMPLATE || '';
  private readonly envFields = (process.env.QR_FIELDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // --- NUEVO: Ventana de espera entre mensajes (3 a 5 segundos) ---
  private readonly minDelayMs = 3000;
  private readonly maxDelayMs = 5000;

  constructor() {
    try {
      new URL(this.apiUrl);
    } catch {
      throw new Error(`API_TARGET_URL inválida o no configurada: "${this.apiUrl}"`);
    }
    if (!this.passphrase || this.passphrase.length < 12) {
      throw new Error('QR_SECRET_KEY no configurado o demasiado corto (>= 12 chars).');
    }
  }

  /**
   * Flujo:
   * 1) Lee Excel
   * 2) Valida encabezados obligatorios
   * 3) Por fila: valida campos requeridos → arma payload → cifra → QR → Storage → API → Firestore
   * 4) Espera 3–5s entre cada fila (mensaje)
   */
  async processExcelUpload(buffer: Buffer) {
    const workbook: any = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const ws = workbook.worksheets[0];
    if (!ws) throw new Error('El Excel no tiene hojas.');

    // ===== Leer y normalizar encabezados =====
    const rawHeaders: string[] = [];
    ws.getRow(1).eachCell((cell, i) => {
      rawHeaders[i - 1] = String(cell.value ?? '');
    });

    const normHeaders = rawHeaders.map(normalizeHeader);

    // Mapear header normalizado -> índice (1-based para ExcelJS)
    const headerIndex = new Map<string, number>();
    normHeaders.forEach((h, idx) => {
      if (h) headerIndex.set(h, idx + 1);
    });

    // ===== Validar presencia EXACTA de las columnas =====
    const missing = REQUIRED_HEADERS.filter((req) => !headerIndex.has(req));
    const extras = normHeaders.filter((h) => h && !REQUIRED_HEADERS.includes(h as RequiredHeader));

    if (missing.length > 0 || extras.length > 0) {
      // Si quieres permitir columnas extra, elimina "extras" de la condición
      const msg = [
        missing.length ? `Faltan columnas: ${missing.join(', ')}` : '',
        extras.length ? `Columnas no permitidas: ${extras.join(', ')}` : '',
        `Encabezados leídos: [${rawHeaders.join(' | ')}]`,
      ]
        .filter(Boolean)
        .join(' | ');
      throw new Error(`Encabezados inválidos. ${msg}`);
    }

    const results: Array<{
      row: number;
      status: 'ok' | 'error' | 'skipped';
      qrUrl?: string;
      error?: string;
    }> = [];

    for (let r = 2; r <= ws.rowCount; r++) {
      let shouldWait = false;
      try {
        const row = ws.getRow(r);

        // ===== Leer valores requeridos por nombre (no por orden) =====
        const record: Record<RequiredHeader, string> = {
          codigo: row.getCell(headerIndex.get('codigo')!).text?.trim() ?? '',
          nombres: row.getCell(headerIndex.get('nombres')!).text?.trim() ?? '',
          telefono: row.getCell(headerIndex.get('telefono')!).text?.trim() ?? '',
          denominacion: row.getCell(headerIndex.get('denominacion')!).text?.trim() ?? '',
          estado: row.getCell(headerIndex.get('estado')!).text?.trim() ?? '',
          numpases: row.getCell(headerIndex.get('numpases')!).text?.trim() ?? '',
        };

        // Fila completamente vacía -> skip
        if (Object.values(record).every((v) => !v)) {
          results.push({ row: r, status: 'skipped' });
          continue;
        }

        // ===== Validación por fila: ningún requerido vacío =====
        const emptyFields = (Object.keys(record) as RequiredHeader[]).filter((k) => !record[k]);
        if (emptyFields.length) {
          throw new Error(`Fila ${r}: campos vacíos -> ${emptyFields.join(', ')}`);
        }

        // ===== 1) Texto plano del QR (usa tu template/envFields o JSON por defecto) =====
        const qrTextPlain = this.buildQrPayload(record);

        // ===== 2) Cifrar → token =====
        const token = encryptForQr(qrTextPlain, this.passphrase);

        // ===== 3) QR PNG + subir a Storage =====
        const png = await QRCode.toBuffer(token, { width: 600, margin: 1 });
        const filename = `qr/qr_row_${r}_${Date.now()}.png`;
        const qrUrl = await this.uploadPngAndGetDownloadUrl(filename, png);

        // ===== 4) Enviar a tu API (multipart) =====
        await this.sendFormDataToApi(
          {
            ...record,
            qr_url: qrUrl,
          } as any,
          png
        );

        // ===== 5) Registrar en Firestore (colección "actors") =====
        await this.logActorToFirestore({
          codigo: record.codigo,
          nombres: record.nombres,
          telefono: record.telefono,
          denominacion: record.denominacion,
          estado: record.estado,
          numpases: record.numpases,
          qrUrl,
          token,
        });

        shouldWait = true; // se envió mensaje/registro para esta fila
        results.push({ row: r, status: 'ok', qrUrl });
      } catch (err: any) {
        const errMsg = err?.response?.data ? JSON.stringify(err.response.data) : String(err);
        results.push({ row: r, status: 'error', error: errMsg });
        // también aplicaremos espera tras error para no martillar el endpoint
        shouldWait = true;
      } finally {
        if (shouldWait) {
          await this.waitBetweenSends(r);
        }
      }
    }

    const ok = results.filter((x) => x.status === 'ok').length;
    const skipped = results.filter((x) => x.status === 'skipped').length;
    const errors = results.filter((x) => x.status === 'error').length;

    return { total: results.length, ok, skipped, errors, results };
  }

  /** Construye el payload del QR (plantilla/envFields o JSON completo) */
  private buildQrPayload(record: Record<string, string>): string {
    if (this.envTemplate) {
      return this.envTemplate.replace(/\{\{(\w+)\}\}/g, (_, k) => record[k] ?? '');
    }
    if (this.envFields.length) {
      return this.envFields
        .map((f) => `${f}=${(record[f] ?? '').replace(/;/g, ',')}`)
        .join(';');
    }
    return JSON.stringify(record);
  }

  /** Sube PNG a Firebase Storage y devuelve URL de descarga con token */
  private async uploadPngAndGetDownloadUrl(filename: string, png: Buffer): Promise<string> {
    const file = this.bucket.file(filename);
    const token = uuidv4();

    await file.save(png, {
      contentType: 'image/png',
      metadata: {
        metadata: { firebaseStorageDownloadTokens: token },
      },
      public: false,
      resumable: false,
    });

    const encodedPath = encodeURIComponent(filename);
    const bucketName = this.bucket.name;
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedPath}?alt=media&token=${token}`;
  }

  /** POST multipart a tu API */
  private async sendFormDataToApi(payload: Record<string, string>, png: Buffer) {
    const form = new FormData();
    // Campos EXACTOS que tu API espera:
    form.append('id_nombre', payload['nombres'] ?? '');
    const celular = (payload['telefono'] ?? '').replace(/[^\d]/g, '');
    form.append('id_celular', celular);
    form.append('linkPath', payload['qr_url'] ?? '');
    form.append('file', png, { filename: 'qr.png', contentType: 'image/png' });

    const headers = { ...form.getHeaders(), Accept: 'application/json' };

    const resp = await axios.post(this.apiUrl, form, {
      headers,
      maxBodyLength: Infinity,
      timeout: 15000,
      validateStatus: () => true,
    });

    console.log('[API status]', resp.status);
    console.log('[API body]', JSON.stringify(resp.data));

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`API respondió ${resp.status}: ${JSON.stringify(resp.data)}`);
    }
  }

  /** Guarda en colección "actors" con los campos solicitados */
  private async logActorToFirestore(entry: {
    codigo: string;
    nombres: string;
    telefono: string;
    denominacion: string;
    estado: string;
    numpases: string;
    qrUrl: string;
    token: string;
  }) {
    await this.db.collection('actors').add({
      codigo: entry.codigo || null,
      nombres: entry.nombres || null,
      telefono: entry.telefono || null,
      denominacion: entry.denominacion || null,
      estado: entry.estado || null,
      numpases: entry.numpases || null,
      qrUrl: entry.qrUrl || null,
      token: entry.token || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  /* ================================
     Helpers de espera (3–5 segundos)
     ================================ */
  private async sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private randInt(min: number, max: number) {
    // entero en [min, max]
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private async waitBetweenSends(rowNumber: number) {
    const delay = this.randInt(this.minDelayMs, this.maxDelayMs);
    console.log(`[Delay] Fila ${rowNumber}: esperando ${delay} ms antes de continuar...`);
    await this.sleep(delay);
  }
}
