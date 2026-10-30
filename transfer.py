#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Immich Google Takeout Transfer Tool
----------------------------------
Google Takeout arşivlerini (fotoğraf/video ve .json yan dosyalarını)
self-hosted Immich sunucunuza güvenle, yüksek doğrulukla ve kaldığı
yerden devam edebilir şekilde aktaran Python betiği.

Özellikler:
- Immich API kimlik doğrulama ve kullanıcı teyidi (/api/users/me)
- Akıllı Google Takeout JSON eşleştirme (.ext.json, kesilmiş isimler, parantezli kopyalar)
- Çekim tarihi (photoTakenTime -> UTC ISO 8601) ve meta veri aktarımı
- Kesinti ve elektrik kopmalarına karşı yerel SQLite Checkpoint (Kaldığı yerden devam etme)
- Rich kütüphanesi ile anlık transfer hızı (MB/s), kalan süre (ETA), GB ve dosya sayaçları
- Tekrarlı / duplicate dosya yönetimi
"""

import os
import sys
import json
import time
import mimetypes
import hashlib
import sqlite3
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any, Tuple, List

import requests
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
# 1. VERİTABANI & CHECKPOINT (Kaldığı Yerden Devam Etme)
# ==============================================================================
class CheckpointDB:
    """
    120 GB gibi büyük aktarımlarda elektrik/ağ kesintisi olsa dahi
    kaldığı yerden anında devam edebilmesi için yerel SQLite veritabanı.
    """
    def __init__(self, db_path: str = "checkpoint.db"):
        self.db_path = db_path
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._create_table()

    def _create_table(self):
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
        cursor = self.conn.cursor()
        cursor.execute("SELECT status FROM uploads WHERE file_path = ?", (file_path,))
        row = cursor.fetchone()
        return row is not None and row[0] in ("SUCCESS", "SKIPPED_DUPLICATE")

    def record_upload(self, file_path: str, file_size: int, status: str, immich_id: str = ""):
        with self.conn:
            self.conn.execute("""
                INSERT OR REPLACE INTO uploads (file_path, file_size, status, immich_id)
                VALUES (?, ?, ?, ?)
            """, (file_path, file_size, status, immich_id))

    def get_stats(self) -> Dict[str, int]:
        cursor = self.conn.cursor()
        cursor.execute("SELECT status, count(*) FROM uploads GROUP BY status")
        return dict(cursor.fetchall())


# ==============================================================================
# 2. CHUNK-BASED PROGRESS WRAPPER (Gerçek Zamanlı MB/s & ETA)
# ==============================================================================
class ProgressFileReader:
    """
    Requests kütüphanesi multipart dosya yüklerken okunan her byte bloğunu
    Rich Progress Bar'a bildirerek gerçek zamanlı upload hızı ve ETA üretir.
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
# 3. GOOGLE TAKEOUT META VERİ YÖNETİCİSİ (Akıllı JSON Eşleştirme)
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
        """
        Bir medya dosyasının (.jpg vb.) Google Takeout'taki .json eşini bulur.
        Denenen formatlar:
        1. filename.ext.json (en standart)
        2. filename.json
        3. Kopya parantezleri: file(1).jpg -> file.jpg(1).json veya file(1).jpg.json
        4. Kırpılmış isimler: Takeout dosya adını bazen 47-51 karakterde keser.
        """
        parent = media_path.parent
        name = media_path.name  # örn: IMG_001.JPG
        stem = media_path.stem  # örn: IMG_001

        # 1. En yaygın varyasyon: dosya.uzantı.json (örn: IMG_001.JPG.json)
        candidate1 = parent / f"{name}.json"
        if candidate1.is_file():
            return candidate1

        # 2. Alternatif: dosya.json (örn: IMG_001.json)
        candidate2 = parent / f"{stem}.json"
        if candidate2.is_file():
            return candidate2

        # 3. Parantezli kopyalar: file(1).jpg -> file.jpg(1).json
        if "(" in stem and stem.endswith(")"):
            # stem: IMG_001(1) -> base: IMG_001, num: (1)
            idx = stem.rfind("(")
            base = stem[:idx]
            suffix = stem[idx:]
            candidate3 = parent / f"{base}{media_path.suffix}{suffix}.json"
            if candidate3.is_file():
                return candidate3

        # 4. Kırpılmış (truncated) isimler (Takeout genelde ~46-51 karakterde keser)
        # Eğer dosya adı çok uzunsa ilk 46 karakterini arayalım
        if len(name) > 45:
            prefix = name[:46]
            for file in parent.iterdir():
                if file.is_file() and file.name.startswith(prefix) and file.name.endswith(".json"):
                    return file

        return None

    @classmethod
    def parse_metadata(cls, media_path: Path) -> Dict[str, Any]:
        """
        JSON dosyasını okuyup Immich'in beklediği tarih, favori ve açıklama
        değerlerini döner. JSON bulunamazsa dosya mtime'ına fallback yapar.
        """
        result = {
            "created_at": None,
            "modified_at": None,
            "is_favorite": False,
            "description": ""
        }

        # Dosyanın disk üzerindeki mtime'ı fallback olarak hazır tutulur
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

            # photoTakenTime.timestamp (Epoch saniye)
            taken_time = data.get("photoTakenTime", {}).get("timestamp")
            if taken_time:
                ts = int(taken_time)
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                result["created_at"] = dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")

            # Açıklama
            desc = data.get("description", "")
            if desc:
                result["description"] = desc

            # Favori
            if data.get("favorited") is True:
                result["is_favorite"] = True

        except Exception:
            # JSON bozuksa sessizce fallback tarihini korur
            pass

        return result


# ==============================================================================
# 4. IMMICH API İSTEMCİSİ
# ==============================================================================
class ImmichClient:
    """
    Immich REST API işlemlerini (Doğrulama, Kullanıcı Bilgisi, Asset Yükleme)
    yürüten istemci.
    """
    def __init__(self, base_url: str, api_key: str):
        # URL sonundaki eğik çizgileri temizle
        self.base_url = base_url.rstrip("/")
        # URL içinde /api yoksa ekle
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

    def get_current_user(self) -> Dict[str, Any]:
        """
        /api/users/me endpoint'ine bağlanarak kimlik doğrulamayı ve
        kullanıcı bilgilerini kontrol eder.
        """
        url = f"{self.api_url}/users/me"
        try:
            res = self.session.get(url, timeout=15)
            if res.status_code == 200:
                return res.json()
            elif res.status_code == 401 or res.status_code == 403:
                raise PermissionError("API Anahtarı geçersiz veya yetersiz yetkiye sahip!")
            else:
                raise ConnectionError(f"Immich sunucusu beklenmeyen yanıt döndü: {res.status_code} - {res.text}")
        except requests.exceptions.RequestException as e:
            raise ConnectionError(f"Immich sunucusuna bağlanılamadı ({url}): {e}")

    def upload_asset(
        self,
        file_path: Path,
        meta: Dict[str, Any],
        progress_callback=None
    ) -> Tuple[bool, str, str]:
        """
        Medya dosyasını ve meta verilerini /api/assets endpoint'ine multipart/form-data
        olarak yükler.
        Döner: (Başarılı mı, Durum/Mesaj, Immich Asset ID)
        """
        url = f"{self.api_url}/assets"

        # Unique deviceAssetId üretimi (Dosya yolu ve boyutu kombinasyonu)
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

        try:
            with ProgressFileReader(str(file_path), progress_callback) as reader:
                files = {
                    "assetData": (file_path.name, reader, mime_type)
                }
                res = self.session.post(url, data=data, files=files, timeout=300)

            # 201 Created veya 200 OK -> Başarılı
            if res.status_code in (200, 201):
                resp_json = res.json()
                # Immich duplicate durumunda 200 dönüp status: 'duplicate' diyebilir
                if resp_json.get("status") == "duplicate":
                    return True, "DUPLICATE", resp_json.get("id", "")
                return True, "SUCCESS", resp_json.get("id", "")

            # 409 Conflict -> Zaten sunucuda var
            elif res.status_code == 409:
                return True, "DUPLICATE", ""

            else:
                return False, f"HTTP {res.status_code}: {res.text[:120]}", ""

        except requests.exceptions.RequestException as e:
            return False, f"Bağlantı hatası: {str(e)}", ""
        except Exception as e:
            return False, f"Beklenmeyen hata: {str(e)}", ""


# ==============================================================================
# 5. DOSYA TARAMA & TRANSFER YÖNETİCİSİ
# ==============================================================================
def scan_takeout_directory(root_dir: Path) -> List[Path]:
    """
    Belirtilen dizindeki desteklenen tüm medya dosyalarını derinlemesine tarar.
    """
    media_files = []
    with console.status("[bold cyan]Google Takeout klasörü taranıyor...[/bold cyan]", spinner="dots"):
        for root, _, files in os.walk(root_dir):
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext in SUPPORTED_EXTENSIONS:
                    media_files.append(Path(root) / file)
    return media_files


def run_transfer():
    # .env dosyasını yükle
    load_dotenv()

    instance_url = os.getenv("IMMICH_INSTANCE_URL")
    api_key = os.getenv("IMMICH_API_KEY")
    takeout_dir_str = os.getenv("TAKEOUT_DIR")

    console.print(Panel.fit(
        "[bold cyan]Immich Google Takeout Transfer Aracı[/bold cyan]\n"
        "[dim]120 GB+ Arşivler için Optimize Edilmiş Güvenli Aktarım[/dim]",
        border_style="cyan"
    ))

    # Gerekli parametre kontrolleri
    if not instance_url or not api_key:
        console.print("[bold red]HATA:[/bold red] .env dosyasında [yellow]IMMICH_INSTANCE_URL[/yellow] veya [yellow]IMMICH_API_KEY[/yellow] eksik!")
        console.print("[dim].env.example dosyasını .env olarak kopyalayıp bilgilerinizi giriniz.[/dim]")
        sys.exit(1)

    if not takeout_dir_str:
        takeout_dir_str = console.input("[bold yellow]Takeout klasörünün tam yolunu girin: [/bold yellow]").strip()

    takeout_dir = Path(takeout_dir_str).expanduser().resolve()
    if not takeout_dir.is_dir():
        console.print(f"[bold red]HATA:[/bold red] Belirtilen Takeout klasörü bulunamadı: {takeout_dir}")
        sys.exit(1)

    # 1. KİMLİK DOĞRULAMA VE HESAP KONTROLÜ
    console.print("\n[bold]1. Immich API Bağlantısı Kontrol Ediliyor...[/bold]")
    client = ImmichClient(instance_url, api_key)

    try:
        user_info = client.get_current_user()
    except Exception as e:
        console.print(f"[bold red]Bağlantı Başarısız:[/bold red] {e}")
        sys.exit(1)

    user_name = user_info.get("name") or "İsimsiz Kullanıcı"
    user_email = user_info.get("email") or "Bilinmiyor"
    user_id = user_info.get("id") or "-"

    # Kullanıcı Onay Tablosu
    auth_table = Table(title="[bold green]Bağlantı Başarılı - Hedef Immich Hesabı[/bold green]", show_header=False)
    auth_table.add_row("Kullanıcı Adı", f"[bold]{user_name}[/bold]")
    auth_table.add_row("E-posta", f"[cyan]{user_email}[/cyan]")
    auth_table.add_row("Kullanıcı ID", f"[dim]{user_id}[/dim]")
    auth_table.add_row("Sunucu Adresi", f"[blue]{instance_url}[/blue]")
    console.print(auth_table)

    if not Confirm.ask("\nFotoğrafların bu hesaba yüklenmesini onaylıyor musunuz?"):
        console.print("[yellow]İşlem kullanıcı tarafından iptal edildi.[/yellow]")
        sys.exit(0)

    # 2. DOSYALARI TARA VE CHECKPOINT İLE KARŞILAŞTIR
    console.print("\n[bold]2. Takeout Arşivi Taranıyor...[/bold]")
    all_files = scan_takeout_directory(takeout_dir)
    total_found = len(all_files)

    if total_found == 0:
        console.print(f"[yellow]Uyarı:[/yellow] {takeout_dir} altında desteklenen medya dosyası bulunamadı.")
        sys.exit(0)

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
    console.print(summary_table)

    if not pending_files:
        console.print("\n[bold green]Tebrikler! Tüm dosyalar zaten Immich'e aktarılmış görünüyor.[/bold green]")
        sys.exit(0)

    if not Confirm.ask("\nAktarım işlemine başlansın mı?"):
        console.print("[yellow]İptal edildi.[/yellow]")
        sys.exit(0)

    # 3. İLERLEME ÇUBUĞU VE AKTARIM DÖNGÜSÜ
    console.print("\n[bold]3. Aktarım Başlatılıyor...[/bold]\n")

    success_count = 0
    duplicate_count = 0
    error_count = 0

    # Rich progress bar kurulumu (Yüzde, Dosya sayısı, MB/s hız, Kalan Süre ETA)
    progress = Progress(
        SpinnerColumn(),
        TextColumn("[bold cyan]{task.fields[filename]}", justify="left"),
        BarColumn(bar_width=40),
        TaskProgressColumn(),
        DownloadColumn(),
        TransferSpeedColumn(),
        TimeRemainingColumn(),
        console=console,
        refresh_per_second=4,
    )

    with progress:
        byte_task = progress.add_task(
            "Upload",
            total=total_pending_bytes,
            filename=f"Başlatılıyor (0/{len(pending_files)})"
        )

        for idx, (media_path, file_size) in enumerate(pending_files, 1):
            short_name = media_path.name
            if len(short_name) > 28:
                short_name = short_name[:25] + "..."

            progress.update(
                byte_task,
                filename=f"[{idx}/{len(pending_files)}] {short_name}"
            )

            # Meta veriyi oku (.json dosyası)
            meta = TakeoutMetadataParser.parse_metadata(media_path)

            # Upload işlemi
            current_file_uploaded_bytes = 0

            def on_chunk_read(chunk_len: int):
                nonlocal current_file_uploaded_bytes
                current_file_uploaded_bytes += chunk_len
                progress.advance(byte_task, chunk_len)

            success, status_msg, immich_id = client.upload_asset(
                media_path,
                meta,
                progress_callback=on_chunk_read
            )

            # Eğer hata olduysa ve hiç chunk okunmadıysa barın geri kalmamasını sağla
            remaining_bytes = file_size - current_file_uploaded_bytes
            if remaining_bytes > 0:
                progress.advance(byte_task, remaining_bytes)

            # Sonuç kaydı
            file_key = str(media_path)
            if success:
                if status_msg == "DUPLICATE":
                    duplicate_count += 1
                    db.record_upload(file_key, file_size, "SKIPPED_DUPLICATE", immich_id)
                else:
                    success_count += 1
                    db.record_upload(file_key, file_size, "SUCCESS", immich_id)
            else:
                error_count += 1
                db.record_upload(file_key, file_size, f"ERROR: {status_msg}")
                # Hata durumunu log dosyasına yaz
                with open("failed_uploads.log", "a", encoding="utf-8") as err_log:
                    err_log.write(f"{datetime.now().isoformat()} | {file_key} | {status_msg}\n")

    # 4. SONUÇ RAPORU
    console.print("\n" + "=" * 60)
    result_table = Table(title="[bold green]Aktarım Tamamlandı![/bold green]")
    result_table.add_column("Kategori", style="bold")
    result_table.add_column("Adet", justify="right")

    result_table.add_row("Başarıyla Yüklenen", f"[green]{success_count:,}[/green]")
    result_table.add_row("Zaten Mevcut (Duplicate Atlandı)", f"[blue]{duplicate_count:,}[/blue]")
    result_table.add_row("Daha Önce Yüklenmiş Olanlar", f"[dim]{already_uploaded_count:,}[/dim]")
    result_table.add_row("Hatalı / Yüklenemeyen", f"[red]{error_count:,}[/red]")
    result_table.add_row("Toplam İşlenen", f"[bold]{total_found:,}[/bold]")
    console.print(result_table)

    if error_count > 0:
        console.print("[yellow]Bazı dosyalar yüklenemedi. Detaylar için 'failed_uploads.log' dosyasını inceleyebilirsiniz.[/yellow]")
        console.print("[dim]Sorunu düzelttikten sonra betiği tekrar çalıştırdığınızda sadece hatalı kalanları deneyecektir.[/dim]")
    else:
        console.print("[bold green]Tüm arşiv başarıyla Immich kütüphanenize aktarıldı![/bold green]")


if __name__ == "__main__":
    try:
        run_transfer()
    except KeyboardInterrupt:
        console.print("\n[bold red]İşlem kullanıcı tarafından durduruldu (Ctrl+C).[/bold red]")
        console.print("[dim]Checkpoint kaydedildi. Betiği tekrar çalıştırdığınızda kaldığı yerden devam edecektir.[/dim]")
        sys.exit(0)
