// Кэширование самоподписанного сертификата для тест-only TLS-прокси E2E.
// Сертификат и ключ объединяются в один PEM и публикуются одним rename:
// параллельные прогоны и обрывы между отдельными rename больше не оставляют
// кэш в состоянии «есть cert, нет key». Существующий файл принимается только
// когда содержит оба блока, иначе перегенерируется (самовосстановление).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const E2E_TLS_PEM_FILE = "tls.pem";

export type EnsureCertificateOptions = {
  // "inherit" — для запуска прокси (openssl виден в логах webServer);
  // "pipe" — для тестов, чтобы вывод не загрязнял отчёт.
  stdio?: "inherit" | "pipe";
};

// Кэш в node_modules (не попадает в git): сертификат один на все прогоны,
// SAN покрывает localhost и 127.0.0.1.
export function defaultE2eTlsCacheDir(): string {
  return join(process.cwd(), "node_modules", ".cache", "words-game-e2e-tls");
}

function isCompleteCombinedPem(pem: string): boolean {
  return pem.includes("-----BEGIN PRIVATE KEY-----") && pem.includes("-----BEGIN CERTIFICATE-----");
}

// Временные каталоги генерации оборвавшихся прогонов удаляются, чтобы кэш
// не копил мусор; вызывается при каждой публикации и приёмке кэша.
export function removeStaleGenerationDirs(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;
  for (const entry of readdirSync(cacheDir)) {
    if (entry.startsWith("gen-")) {
      rmSync(join(cacheDir, entry), { recursive: true, force: true });
    }
  }
}

// Атомарная публикация: openssl пишет в уникальный tmpDir процесса, далее
// комбинированный PEM записывается там и одним rename публикуется в кэш;
// tmpDir удаляется в finally, включая обрыв по ошибке openssl.
export function ensureE2eTlsCertificate(
  cacheDir: string = defaultE2eTlsCacheDir(),
  options: EnsureCertificateOptions = {},
): string {
  const stdio = options.stdio ?? "inherit";
  const pemPath = join(cacheDir, E2E_TLS_PEM_FILE);
  removeStaleGenerationDirs(cacheDir);
  if (existsSync(pemPath) && isCompleteCombinedPem(readFileSync(pemPath, "utf8"))) {
    return pemPath;
  }

  mkdirSync(cacheDir, { recursive: true });
  const tmpDir = join(cacheDir, `gen-${process.pid}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    const result = spawnSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", join(tmpDir, "key.pem"),
        "-out", join(tmpDir, "cert.pem"),
        "-days", "3650",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio },
    );
    if (result.status !== 0) {
      throw new Error(`openssl failed to generate the E2E TLS certificate (exit ${result.status})`);
    }
    const key = readFileSync(join(tmpDir, "key.pem"), "utf8").trimEnd();
    const cert = readFileSync(join(tmpDir, "cert.pem"), "utf8");
    const staged = join(tmpDir, E2E_TLS_PEM_FILE);
    writeFileSync(staged, `${key}\n${cert}`);
    renameSync(staged, pemPath);
    return pemPath;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
