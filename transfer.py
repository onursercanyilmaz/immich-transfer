#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Immich Google Takeout Transfer Tool (Resilient Multi-Thread Edition)
-------------------------------------------------------------------
Google Takeout arşivlerini (fotoğraf/video ve .json yan dosyalarını)
self-hosted Immich sunucunuza paralel çoklu iş parçacığı (multi-threading)
kullanarak maksimum ağ hızıyla aktaran ve kesintilere karşı dayanıklı Python betiği.

Özellikler:
- Asla Kapanmayan Terminal: İşlem bitse veya hata çıksa dahi terminal otomatik kapanmaz (ENTER bekleme).
- fsync Destekli Kalıcı Loglama (transfer.log): PC kapansa dahi en son yapılan işlem anında diske yazılır.
- Otomatik Ağ Hatası Yeniden Deneme (Exponential Backoff Retry).
- Eşzamanlı (Paralel) Yükleme: CONCURRENCY ile ayarlanabilir worker havuzu (Varsayılan: 4-8 thread).
- Immich API kimlik doğrulama ve kullanıcı teyidi (/api/users/me).
- Akıllı Google Takeout JSON eşleştirme (.ext.json, kesilmiş isimler, parantezli kopyalar).
- Çekim tarihi (photoTakenTime -> UTC ISO 8601) ve meta veri aktarımı.
- Thread-safe yerel SQLite Checkpoint (Kaldığı yerden devam etme garantisi).
- Rich kütüphanesi ile anlık birleşik transfer hızı (MB/s), kalan süre (ETA) ve sayaçlar.
"""

import os
import sys
import json
import time
import mimetypes
import hashlib
import sqlite3
import unicodedata
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any, Tuple, List
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.prompt import Confirm
from rich.progress import (
    Progress,
    SpinnerColumn,
    TextColumn,
    BarColumn,
    TaskProgressColumn,
    DownloadColumn,
    TransferSpeedColumn,
    TimeRemainingColumn,
)

# Konsol nesnesi
console = Console()

# Desteklenen medya uzantıları (küçük harf)
SUPPORTED_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif",
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm",
    ".gif", ".dng", ".raw", ".cr2", ".nef", ".arw"
}


# ==============================================================================
# 1. KALICI VE DİSKE ANINDA YAZILAN LOG YÖNETİCİSİ (fsync)
# ==============================================================================
class PersistentLogger:
    """
    Tüm hareketleri 'transfer.log' dosyasına anında yazar ve os.fsync()
    kullanarak işletim sistemi önbelleğini diske boşaltır.
    Böylece bilgisayar aniden kapansa dahi son durum asla kaybolmaz.
    """
    def __init__(self, log_path: str = "transfer.log"):
        self.log_path = log_path
        self.lock = threading.Lock()

    def log(self, level: str, message: str):
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{now_str}] [{level.upper():<7}] {message}\n"
        with self.lock:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(line)
                f.flush()
                try:
                    os.fsync(f.fileno())  # Doğrudan fiziksel diske yazma garantisi
                except OSError:
                    pass


# Global logger nesnesi
logger = PersistentLogger("transfer.log")


# ==============================================================================
# 2. THREAD-SAFE VERİTABANI & CHECKPOINT (Kaldığı Yerden Devam Etme)
# ==============================================================================
class CheckpointDB:
    """
    Paralel iş parçacıklarının aynı anda erişimine uygun,
    thread-safe yerel SQLite veritabanı yöneticisi.
    """
    def __init__(self, db_path: str = "checkpoint.db"):
        self.db_path = db_path
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._create_table()

    def _create_table(self):
        with self.lock:
            with self.conn:
                self.conn.execute("""
                    CREATE TABLE IF NOT EXISTS uploads (
                        file_path TEXT PRIMARY KEY,
                        file_size INTEGER,
                        status TEXT,
                        immich_id TEXT,
                        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

    def is_uploaded(self, file_path: str) -> bool:
        with self.lock:
            cursor = self.conn.cursor()
            cursor.execute("SELECT status FROM uploads WHERE file_path = ?", (file_path,))
            row = cursor.fetchone()
            return row is not None and row[0] in ("SUCCESS", "SKIPPED_DUPLICATE")

    def record_upload(self, file_path: str, file_size: int, status: str, immich_id: str = ""):
        with self.lock:
            with self.conn:
                self.conn.execute("""
                    INSERT OR REPLACE INTO uploads (file_path, file_size, status, immich_id)
                    VALUES (?, ?, ?, ?)
                """, (file_path, file_size, status, immich_id))

    def get_stats(self) -> Dict[str, int]:
        with self.lock:
            cursor = self.conn.cursor()
            cursor.execute("SELECT status, count(*) FROM uploads GROUP BY status")
            return dict(cursor.fetchall())


# ==============================================================================
# 3. CHUNK-BASED PROGRESS WRAPPER (Gerçek Zamanlı MB/s & ETA)
# ==============================================================================
class ProgressFileReader:
    """
    Requests kütüphanesi dosyayı stream ederken okunan her byte bloğunu
    Rich Progress Bar'a bildirerek birleşik upload hızı (MB/s) üretir.
    """
    def __init__(self, filepath: str, progress_callback):
        self.filepath = filepath
        self.file = open(filepath, "rb")
        self.size = os.path.getsize(filepath)
        self.callback = progress_callback

    def read(self, size: int = -1) -> bytes:
        chunk = self.file.read(size)
        if chunk and self.callback:
            self.callback(len(chunk))
        return chunk

    def seek(self, offset: int, whence: int = 0) -> int:
        return self.file.seek(offset, whence)

    def tell(self) -> int:
        return self.file.tell()

    def close(self):
        self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def __len__(self) -> int:
        return self.size


# ==============================================================================
# 4. GOOGLE TAKEOUT META VERİ YÖNETİCİSİ (Akıllı JSON Eşleştirme)
# ==============================================================================
class TakeoutMetadataParser:
    """
    Google Takeout'un karmaşık dosya adı ve kırpılmış JSON eşleştirme
    mantıklarını çözen sınıf.
    """
    @staticmethod
    def normalize_str(s: str) -> str:
        return unicodedata.normalize("NFC", s)

    @classmethod
    def find_json_path(cls, media_path: Path) -> Optional[Path]:
        parent = media_path.parent
        name = media_path.name
        stem = media_path.stem

        # 1. En yaygın format: dosya.uzantı.json (örn: IMG_001.JPG.json)
        candidate1 = parent / f"{name}.json"
        if candidate1.is_file():
            return candidate1

        # 2. Alternatif: dosya.json (örn: IMG_001.json)
        candidate2 = parent / f"{stem}.json"
        if candidate2.is_file():
            return candidate2

        # 3. Parantezli kopyalar: file(1).jpg -> file.jpg(1).json
        if "(" in stem and stem.endswith(")"):
            idx = stem.rfind("(")
            base = stem[:idx]
            suffix = stem[idx:]
            candidate3 = parent / f"{base}{media_path.suffix}{suffix}.json"
            if candidate3.is_file():
                return candidate3

        # 4. Kırpılmış (truncated) isimler (~46-51 karakter limiti)
        if len(name) > 45:
            prefix = name[:46]
            for file in parent.iterdir():
                if file.is_file() and file.name.startswith(prefix) and file.name.endswith(".json"):
                    return file

        return None

    @classmethod
    def parse_metadata(cls, media_path: Path) -> Dict[str, Any]:
        result = {
            "created_at": None,
            "modified_at": None,
            "is_favorite": False,
            "description": ""
        }

        mtime = datetime.fromtimestamp(media_path.stat().st_mtime, tz=timezone.utc)
        fallback_iso = mtime.strftime("%Y-%m-%dT%H:%M:%S.000Z")
        result["modified_at"] = fallback_iso
        result["created_at"] = fallback_iso

        json_path = cls.find_json_path(media_path)
        if not json_path:
            return result

        try:
            with open(json_path, "r", encoding="utf-8", errors="ignore") as f:
                data = json.load(f)

            taken_time = data.get("photoTakenTime", {}).get("timestamp")
            if taken_time:
                ts = int(taken_time)
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                result["created_at"] = dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

            desc = data.get("description", "")
            if desc:
                result["description"] = desc

            if data.get("favorited") is True:
                result["is_favorite"] = True

        except Exception:
            pass

        return result


# ==============================================================================
# 5. IMMICH API İSTEMCİSİ (Otomatik Yeniden Deneme / Retry Destekli)
# ==============================================================================
class ImmichClient:
    """
    Immich REST API işlemlerini yürüten, bağlantı kopmalarına karşı
    exponential backoff retry mekanizması barındıran istemci.
    """
    def __init__(self, base_url: str, api_key: str, pool_size: int = 8):
        self.base_url = base_url.rstrip("/")
        if not self.base_url.endswith("/api"):
            self.api_url = f"{self.base_url}/api"
        else:
            self.api_url = self.base_url

        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update({
            "x-api-key": self.api_key,
            "Accept": "application/json"
        })

        adapter = HTTPAdapter(
            pool_connections=pool_size * 2,
            pool_maxsize=pool_size * 2,
            max_retries=Retry(total=2, backoff_factor=1, status_forcelist=[502, 503, 504])
        )
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

    def get_current_user(self) -> Dict[str, Any]:
        url = f"{self.api_url}/users/me"
        try:
            res = self.session.get(url, timeout=15)
            if res.status_code == 200:
                return res.json()
            elif res.status_code in (401, 403):
                raise PermissionError("API Anahtarı geçersiz veya yetersiz yetkiye sahip!")
            else:
                raise ConnectionError(f"Immich sunucusu beklenmeyen yanıt döndü: {res.status_code} - {res.text}")
        except requests.exceptions.RequestException as e:
            raise ConnectionError(f"Immich sunucusuna bağlanılamadı ({url}): {e}")

    def upload_asset(
        self,
        file_path: Path,
        meta: Dict[str, Any],
        progress_callback=None,
        max_retries: int = 3
    ) -> Tuple[bool, str, str]:
        url = f"{self.api_url}/assets"

        file_stat = file_path.stat()
        raw_id = f"{file_path.name}_{file_stat.st_size}_{meta['created_at']}"
        device_asset_id = hashlib.sha1(raw_id.encode("utf-8")).hexdigest()

        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"

        data = {
            "deviceAssetId": device_asset_id,
            "deviceId": "google-takeout-transfer",
            "fileCreatedAt": meta["created_at"],
            "fileModifiedAt": meta["modified_at"],
            "isFavorite": "true" if meta["is_favorite"] else "false",
        }

        # Ağ kopmalarına karşı kademeli yeniden deneme döngüsü
        last_error = ""
        for attempt in range(1, max_retries + 1):
            try:
                with ProgressFileReader(str(file_path), progress_callback) as reader:
                    files = {
                        "assetData": (file_path.name, reader, mime_type)
                    }
                    res = self.session.post(url, data=data, files=files, timeout=300)

                if res.status_code in (200, 201):
                    resp_json = res.json()
                    if resp_json.get("status") == "duplicate":
                        return True, "DUPLICATE", resp_json.get("id", "")
                    return True, "SUCCESS", resp_json.get("id", "")

                elif res.status_code == 409:
                    return True, "DUPLICATE", ""

                elif res.status_code in (500, 502, 503, 504):
                    last_error = f"HTTP {res.status_code}"
                    logger.log("WARN", f"Sunucu geçici hata verdi ({last_error}) [{file_path.name}] - Deneme {attempt}/{max_retries}")
                    time.sleep(attempt * 2)
                    continue

                else:
                    return False, f"HTTP {res.status_code}: {res.text[:120]}", ""

            except requests.exceptions.RequestException as e:
                last_error = str(e)
                logger.log("WARN", f"Ağ bağlantı hatası [{file_path.name}]: {last_error} - {attempt * 2} sn sonra tekrar denenecek...")
                time.sleep(attempt * 2)
            except Exception as e:
                return False, f"Beklenmeyen hata: {str(e)}", ""

        return False, f"Maksimum deneme aşıldı ({max_retries}): {last_error}", ""


# ==============================================================================
# 6. DOSYA TARAMA & PARALEL TRANSFER YÖNETİCİSİ
# ==============================================================================
def scan_takeout_directory(root_dir: Path) -> List[Path]:
    media_files = []
    with console.status("[bold cyan]Google Takeout klasörü taranıyor...[/bold cyan]", spinner="dots"):
        for root, _, files in os.walk(root_dir):
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext in SUPPORTED_EXTENSIONS:
                    media_files.append(Path(root) / file)
    return media_files


def run_transfer():
    load_dotenv()

    logger.log("INFO", "=== Immich Transfer Oturumu Başlatıldı ===")

    instance_url = os.getenv("IMMICH_INSTANCE_URL")
    api_key = os.getenv("IMMICH_API_KEY")
    takeout_dir_str = os.getenv("TAKEOUT_DIR")
    concurrency = int(os.getenv("CONCURRENCY", "4"))

    console.print(Panel.fit(
        "[bold cyan]Immich Google Takeout Kesintisiz Transfer Aracı[/bold cyan]\n"
        f"[dim]120 GB+ Arşivler için Kalıcı fsync Loglama ve Paralel ({concurrency} Thread) Aktarım[/dim]",
        border_style="cyan"
    ))

    if not instance_url or not api_key:
        err_msg = ".env dosyasında IMMICH_INSTANCE_URL veya IMMICH_API_KEY eksik!"
        console.print(f"[bold red]HATA:[/bold red] {err_msg}")
        logger.log("ERROR", err_msg)
        return

    if not takeout_dir_str:
        takeout_dir_str = console.input("[bold yellow]Takeout klasörünün tam yolunu girin: [/bold yellow]").strip()

    takeout_dir = Path(takeout_dir_str).expanduser().resolve()
    if not takeout_dir.is_dir():
        err_msg = f"Belirtilen Takeout klasörü bulunamadı: {takeout_dir}"
        console.print(f"[bold red]HATA:[/bold red] {err_msg}")
        logger.log("ERROR", err_msg)
        return

    # 1. KİMLİK DOĞRULAMA VE HESAP KONTROLÜ
    console.print("\n[bold]1. Immich API Bağlantısı Kontrol Ediliyor...[/bold]")
    logger.log("INFO", f"Immich sunucusuna bağlanılıyor: {instance_url}")
    client = ImmichClient(instance_url, api_key, pool_size=concurrency)

    try:
        user_info = client.get_current_user()
    except Exception as e:
        err_msg = f"Immich bağlantısı başarısız: {e}"
        console.print(f"[bold red]{err_msg}[/bold red]")
        logger.log("CRITICAL", err_msg)
        return

    user_name = user_info.get("name") or "İsimsiz Kullanıcı"
    user_email = user_info.get("email") or "Bilinmiyor"
    user_id = user_info.get("id") or "-"

    logger.log("INFO", f"Doğrulanan Kullanıcı: {user_name} ({user_email}) [ID: {user_id}]")

    auth_table = Table(title="[bold green]Bağlantı Başarılı - Hedef Immich Hesabı[/bold green]", show_header=False)
    auth_table.add_row("Kullanıcı Adı", f"[bold]{user_name}[/bold]")
    auth_table.add_row("E-posta", f"[cyan]{user_email}[/cyan]")
    auth_table.add_row("Kullanıcı ID", f"[dim]{user_id}[/dim]")
    auth_table.add_row("Sunucu Adresi", f"[blue]{instance_url}[/blue]")
    auth_table.add_row("Eşzamanlılık (Paralel)", f"[bold green]{concurrency} Worker (Thread)[/bold green]")
    auth_table.add_row("Kalıcı Log Dosyası", "[dim]transfer.log (fsync aktif)[/dim]")
    console.print(auth_table)

    if not Confirm.ask("\nFotoğrafların bu hesaba yüklenmesini onaylıyor musunuz?"):
        console.print("[yellow]İşlem kullanıcı tarafından iptal edildi.[/yellow]")
        logger.log("INFO", "Kullanıcı onayı verilmedi, iptal edildi.")
        return

    # 2. DOSYALARI TARA VE CHECKPOINT İLE KARŞILAŞTIR
    console.print("\n[bold]2. Takeout Arşivi Taranıyor...[/bold]")
    all_files = scan_takeout_directory(takeout_dir)
    total_found = len(all_files)
    logger.log("INFO", f"Tarama tamamlandı: {total_found} medya dosyası tespit edildi.")

    if total_found == 0:
        console.print(f"[yellow]Uyarı:[/yellow] {takeout_dir} altında desteklenen medya dosyası bulunamadı.")
        return

    # Checkpoint DB başlat
    db = CheckpointDB("checkpoint.db")

    pending_files = []
    already_uploaded_count = 0
    total_pending_bytes = 0

    for f in all_files:
        f_str = str(f)
        if db.is_uploaded(f_str):
            already_uploaded_count += 1
        else:
            try:
                size = f.stat().st_size
                pending_files.append((f, size))
                total_pending_bytes += size
            except OSError:
                continue

    total_pending_gb = total_pending_bytes / (1024 ** 3)

    summary_table = Table(title="[bold blue]Tarama Özeti[/bold blue]", show_header=False)
    summary_table.add_row("Toplam Bulunan Medya", f"{total_found:,} dosya")
    summary_table.add_row("Daha Önce Yüklenmiş (Checkpoint)", f"[green]{already_uploaded_count:,} dosya (Atlanacak)[/green]")
    summary_table.add_row("Yüklenecek Yeni Dosyalar", f"[bold yellow]{len(pending_files):,} dosya[/bold yellow]")
    summary_table.add_row("Toplam Aktarılacak Boyut", f"[bold magenta]{total_pending_gb:.2f} GB[/bold magenta]")
    summary_table.add_row("Paralel İş Parçacığı", f"[bold cyan]{concurrency} Thread[/bold cyan]")
    console.print(summary_table)

    logger.log("INFO", f"Özet: {already_uploaded_count} dosya daha önce aktarılmış, {len(pending_files)} yeni dosya ({total_pending_gb:.2f} GB) yüklenecek.")

    if not pending_files:
        console.print("\n[bold green]Tebrikler! Tüm dosyalar zaten Immich'e aktarılmış görünüyor.[/bold green]")
        logger.log("INFO", "Yüklenecek yeni dosya yok. Tüm arşiv zaten aktarılmış.")
        return

    if not Confirm.ask("\nParalel aktarım işlemine başlansın mı?"):
        console.print("[yellow]İptal edildi.[/yellow]")
        logger.log("INFO", "Transfer kullanıcı tarafından başlatılmadan iptal edildi.")
        return

    # 3. PARALEL İLERLEME ÇUBUĞU VE AKTARIM DÖNGÜSÜ
    console.print(f"\n[bold]3. Paralel Aktarım Başlatılıyor ({concurrency} Thread)...[/bold]\n")
    logger.log("INFO", f"Transfer döngüsü başladı. Concurrency={concurrency}")

    stats_lock = threading.Lock()
    success_count = 0
    duplicate_count = 0
    error_count = 0
    completed_files = 0

    progress = Progress(
        SpinnerColumn(),
        TextColumn("[bold cyan]{task.fields[status_info]}", justify="left"),
        BarColumn(bar_width=40),
        TaskProgressColumn(),
        DownloadColumn(),
        TransferSpeedColumn(),
        TimeRemainingColumn(),
        console=console,
        refresh_per_second=4,
    )

    abort_event = threading.Event()

    def worker_upload(item: Tuple[Path, int]):
        nonlocal success_count, duplicate_count, error_count, completed_files

        if abort_event.is_set():
            return

        media_path, file_size = item
        file_key = str(media_path)
        meta = TakeoutMetadataParser.parse_metadata(media_path)

        file_uploaded_bytes = 0
        def on_chunk_read(chunk_len: int):
            nonlocal file_uploaded_bytes
            file_uploaded_bytes += chunk_len
            progress.advance(byte_task, chunk_len)

        success, status_msg, immich_id = client.upload_asset(
            media_path,
            meta,
            progress_callback=on_chunk_read
        )

        remaining_bytes = file_size - file_uploaded_bytes
        if remaining_bytes > 0:
            progress.advance(byte_task, remaining_bytes)

        # Thread-safe kayıt ve loglama
        with stats_lock:
            completed_files += 1
            if success:
                if status_msg == "DUPLICATE":
                    duplicate_count += 1
                    db.record_upload(file_key, file_size, "SKIPPED_DUPLICATE", immich_id)
                    logger.log("SKIP", f"Zaten mevcut: {media_path.name}")
                else:
                    success_count += 1
                    db.record_upload(file_key, file_size, "SUCCESS", immich_id)
                    logger.log("SUCCESS", f"Yüklendi: {media_path.name} ({file_size / (1024*1024):.2f} MB)")
            else:
                error_count += 1
                db.record_upload(file_key, file_size, f"ERROR: {status_msg}")
                logger.log("ERROR", f"Başarısız: {media_path.name} | Hata: {status_msg}")
                with open("failed_uploads.log", "a", encoding="utf-8") as err_log:
                    err_log.write(f"{datetime.now().isoformat()} | {file_key} | {status_msg}\n")

            # Periyodik ilerleme kaydı (Her 50 dosyada bir genel durumu logla)
            if completed_files % 50 == 0 or completed_files == len(pending_files):
                pct = (completed_files / len(pending_files)) * 100
                logger.log("STATUS", f"İlerleme: {completed_files}/{len(pending_files)} (%{pct:.1f}) | Başarılı: {success_count} | Atlanan: {duplicate_count} | Hata: {error_count}")

            progress.update(
                byte_task,
                status_info=f"[{completed_files}/{len(pending_files)}] Başarılı: {success_count} | Atlanan: {duplicate_count}"
            )

    with progress:
        byte_task = progress.add_task(
            "Upload",
            total=total_pending_bytes,
            status_info=f"[0/{len(pending_files)}] Başlatılıyor..."
        )

        try:
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = [executor.submit(worker_upload, item) for item in pending_files]
                for future in as_completed(futures):
                    if abort_event.is_set():
                        break
                    try:
                        future.result()
                    except Exception as e:
                        logger.log("CRITICAL", f"Worker Thread İstisnası: {str(e)}")
        except KeyboardInterrupt:
            abort_event.set()
            console.print("\n[bold red]İşlem kullanıcı tarafından durduruldu (Ctrl+C).[/bold red]")
            logger.log("WARN", "Kullanıcı Ctrl+C ile işlemi durdurdu.")

    # 4. SONUÇ RAPORU
    console.print("\n" + "=" * 60)
    result_table = Table(title="[bold green]Aktarım Özeti[/bold green]")
    result_table.add_column("Kategori", style="bold")
    result_table.add_column("Adet", justify="right")

    result_table.add_row("Başarıyla Yüklenen", f"[green]{success_count:,}[/green]")
    result_table.add_row("Zaten Mevcut (Duplicate Atlandı)", f"[blue]{duplicate_count:,}[/blue]")
    result_table.add_row("Daha Önce Yüklenmiş Olanlar", f"[dim]{already_uploaded_count:,}[/dim]")
    result_table.add_row("Hatalı / Yüklenemeyen", f"[red]{error_count:,}[/red]")
    result_table.add_row("Toplam İşlenen", f"[bold]{total_found:,}[/bold]")
    console.print(result_table)

    logger.log("INFO", f"Oturum Sonu Özeti: Başarılı={success_count}, Duplicate={duplicate_count}, Hatalı={error_count}")

    if error_count > 0:
        console.print("[yellow]Bazı dosyalar yüklenemedi. Detaylar için 'failed_uploads.log' ve 'transfer.log' dosyalarını inceleyebilirsiniz.[/yellow]")
    else:
        console.print("[bold green]Tüm işlem başarıyla tamamlandı![/bold green]")


# ==============================================================================
# GİRİŞ NOKTASI (ASLA KAPANMAYAN TERMINAL GÜVENCESİ)
# ==============================================================================
if __name__ == "__main__":
    try:
        run_transfer()
    except KeyboardInterrupt:
        console.print("\n[bold red]İşlem kullanıcı tarafından durduruldu (Ctrl+C).[/bold red]")
        logger.log("WARN", "Program Ctrl+C ile sonlandırıldı.")
    except Exception as e:
        console.print(f"\n[bold red]Beklenmeyen bir hata oluştu:[/bold red] {e}")
        logger.log("CRITICAL", f"Beklenmeyen genel hata: {e}")
    finally:
        console.print("\n" + "-" * 60)
        console.print("[bold yellow]NOT:[/bold yellow] [dim]Tüm hareketler 'transfer.log' dosyasına anında yazılmıştır.[/dim]")
        try:
            input("\n[bold green]Pencereyi kapatmak veya çıkmak için ENTER tuşuna basınız...[/bold green]")
        except (KeyboardInterrupt, EOFError):
            pass
        sys.exit(0)
