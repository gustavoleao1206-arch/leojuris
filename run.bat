@echo off
REM ============================================
REM   CRM Juridico - inicializacao (Windows)
REM ============================================
cd /d "%~dp0backend"

REM Cria o ambiente virtual na primeira execucao
if not exist "venv\" (
    echo Criando ambiente virtual...
    python -m venv venv
)

call venv\Scripts\activate

REM Instala dependencias
echo Instalando dependencias...
pip install -r requirements.txt

REM Roda o seed apenas se o banco ainda nao existir
if not exist "crm.db" (
    echo Populando banco com dados de exemplo...
    python seed.py
)

echo.
echo ============================================
echo  Servidor: http://127.0.0.1:8000
echo  API docs: http://127.0.0.1:8000/docs
echo  Login: admin@escritorio.com / admin123
echo ============================================
echo.

uvicorn app.main:app --reload
