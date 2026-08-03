# Distributed Software Factory

Tempat seluruh alur pengembangan perangkat lunak dijalankan sebagai pipeline berbentuk graph: dari menyusun product requirement, sampai implementasi, review, dan test. Sebagian langkah digerakkan AI coding agent sendirian, sebagian lagi menuntut manusia ikut di dalamnya. Pekerjaan dibagikan ke mesin-mesin yang didaftarkan sebuah organisasi.

## Language

### Definisi dan eksekusi

**Pipeline**:
Definisi sebuah graph langkah, ditulis sekali dan dipakai berkali-kali. Ia adalah cetakan, bukan pekerjaan. Ia hidup sebagai satu file YAML di dalam Repo Tuan Rumah-nya, dan identitasnya adalah pasangan repo itu dengan path file-nya.
_Avoid_: Workflow, job, template

**Repo Tuan Rumah**:
Repository tempat file definisi sebuah Pipeline tinggal. Definisi selalu dibaca dari ref repo ini, bukan dari repo lain yang ikut disentuh Pipeline tersebut.
_Avoid_: Repo utama, source repo, config repo (repo config Project hanyalah salah satu bentuknya)

**Step**:
Satu simpul di dalam definisi Pipeline. Ia menyatakan pekerjaan apa yang harus dilakukan, bukan pekerjaan yang sedang berlangsung.
_Avoid_: Task, node, stage

**Run**:
Satu eksekusi sebuah Pipeline, dari dipicu sampai berakhir. Ia menyimpan salinan penuh teks definisi yang melahirkannya, sehingga tetap terbaca meskipun definisi aslinya berubah atau hilang.
_Avoid_: PipelineRun, build, execution, job

**StepRun**:
Satu eksekusi sebuah Step di dalam sebuah Run. Satu Step dapat melahirkan banyak StepRun bila ia di-fan-out.
_Avoid_: Attempt, task run, execution

**Graph**:
Susunan StepRun beserta ketergantungannya di dalam satu Run. Ia dimiliki Run, bukan Pipeline, karena simpul-simpulnya sebagian lahir saat Run berjalan.
_Avoid_: DAG, plan, tree

**Fan-out**:
Kelahiran beberapa StepRun dari satu Step, jumlah dan identitasnya ditentukan oleh Output dari Step sebelumnya.
_Avoid_: Parallelism, matrix, branching

**Key**:
Penanda bermakna yang membedakan StepRun bersaudara hasil fan-out, berasal dari data yang melahirkannya. Ia muncul di nama Branch, di log, dan di UI.
_Avoid_: Index, shard, slot

**Join**:
Step yang bergantung pada lebih dari satu StepRun dan berjalan setelah mereka berakhir.
_Avoid_: Merge, gather, collect, reduce

### Yang mengalir dan yang tertinggal

**Output**:
Apa yang sebuah StepRun berikan kepada StepRun sesudahnya: satu Ref, ditambah data terstruktur yang tervalidasi skema. Hanya ini yang mengalir di sepanjang Graph.
_Avoid_: Result, return value, payload

**Ref**:
Penunjuk ke keadaan kode: nama Branch beserta commit SHA-nya. Ini cara kerja berpindah antar mesin.
_Avoid_: Commit, revision, checkpoint

**Branch**:
Branch git tempat sebuah StepRun menaruh hasil kerjanya, didorong ke Git Remote agar StepRun berikutnya di mesin lain dapat mengambilnya.
_Avoid_: Ref (Ref adalah penunjuknya, bukan branch-nya)

**Git Remote**:
Repositori git bersama yang menjadi jalur perpindahan kode antar mesin.
_Avoid_: Origin, upstream, remote saja

**Artifact**:
Apa pun yang dihasilkan sebuah StepRun untuk dibaca manusia: diff, transkrip percakapan agent, dokumen markdown, keluaran perintah, berkas biner. Artifact direkam dan dapat diperiksa, tetapi tidak mengalir ke StepRun berikutnya — yang mengalir hanyalah Output.
_Avoid_: Output (Output adalah yang mengalir; Artifact adalah yang tertinggal untuk dibaca), attachment, asset

### Pelaku

**Runner**:
Mesin terdaftar yang menarik pekerjaan dari control plane dan menjalankannya, entah di dalam kontainer atau langsung di host. Ia selalu yang memulai koneksi.
_Avoid_: Worker, node, machine, agent

**Agent**:
AI coding agent yang bekerja di dalam Sandbox — Claude Code, Codex, Cursor. Istilah ini milik alat, bukan milik mesin.
_Avoid_: Bot, model, assistant, worker

**Sandbox**:
Lingkungan terisolasi di atas sebuah Runner tempat satu Agent bekerja, dengan kode sudah ter-checkout.
_Avoid_: Container, workspace, VM

**Principal**:
Identitas yang dapat memicu Run dan memiliki credential — seorang User atau sebuah ServiceAccount. Credential dan izin menempel ke Principal, tidak pernah ke Run.
_Avoid_: Actor, identity, account

**User**:
Manusia yang masuk ke sistem. Sebuah jenis Principal.
_Avoid_: Member, person, account

**ServiceAccount**:
Principal non-manusia milik sebuah Project, dipakai oleh Run yang dipicu secara otomatis dan tidak memiliki manusia di belakangnya.
_Avoid_: Bot user, system user, machine account

### Pemilikan dan batas

**Project**:
Unit isolasi. Anggota, peran, credential, secret, ServiceAccount, Pipeline, dan Repository semuanya menempel padanya. Batas keamanan berhenti di sini: sebuah Pipeline tidak dapat melihat secret milik Project lain.
_Avoid_: Team, workspace, namespace, org

**Repository**:
Repositori git yang menjadi anggota sebuah Project. Satu Pipeline boleh menyentuh beberapa Repository di dalam Project-nya.
_Avoid_: Repo saja, codebase, project

**Group**:
Himpunan bernama berisi anggota sebuah Project, dipakai untuk menyebut siapa yang diminta menjawab sebuah Question. Ia menjawab "siapa yang ditanya", bukan "siapa yang boleh apa" — itu urusan peran. Anggotanya selalu anggota Project yang sama, jadi ia tidak pernah menjadi jalur akses.
_Avoid_: Role (role adalah izin), team, audience

**Automation**:
Aturan yang memicu Run tanpa manusia — dari webhook atau jadwal. Ia berjalan sebagai ServiceAccount milik Project-nya.
_Avoid_: Trigger, schedule, cron, hook

### Langkah yang menunggu manusia

**Interactive Step**:
Step yang berhenti dan menunggu jawaban manusia, berdurasi menit sampai hari, dan bertahan melewati restart control plane. Kebalikannya berjalan tanpa manusia sampai selesai.
_Avoid_: Human gate, approval, pause, manual step

**Question**:
Permintaan jawaban dari manusia, diterbitkan oleh Interactive Step dan disimpan di control plane. Ia tetap ada meskipun Runner mati atau browser ditutup.
_Avoid_: Prompt (prompt adalah milik Agent), request, ask
