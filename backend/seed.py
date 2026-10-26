"""Popula o banco com dados de exemplo (seed).

Uso:
    python seed.py

Cria um usuário administrador, clientes em diferentes etapas do funil,
processos, prazos e audiências. Pode ser executado novamente: ele limpa
os dados existentes antes de recriar.
"""
import os
from datetime import datetime, date, timedelta

from app.database import Base, engine, SessionLocal
from app import models
from app.auth import hash_password
from app.config import IS_SQLITE


def run():
    # 🚨 TRAVA DE AMBIENTE — este script é DESTRUTIVO (apaga usuários, clientes,
    # processos, prazos, documentos) e lê a MESMA DATABASE_URL da aplicação. Sem
    # esta trava, rodá-lo com a variável de produção apontada apagava produção
    # (achado crítico da auditoria de ago/2026). Só roda em SQLite local; contra
    # qualquer outro banco exige uma confirmação explícita e barulhenta.
    if not IS_SQLITE and os.getenv("SEED_CONFIRMO_APAGAR_TUDO") != "1":
        raise SystemExit(
            "ABORTADO: seed.py apaga TODOS os dados e o banco atual NÃO é SQLite "
            "(parece produção). Se você REALMENTE quer apagar e repopular este "
            "banco, rode com SEED_CONFIRMO_APAGAR_TUDO=1. Nunca faça isso em produção."
        )

    # Senhas fora do código: em produção vêm de variável de ambiente; o valor de
    # desenvolvimento só é usado no SQLite local, onde não há dado real.
    senha_admin = os.getenv("ADMIN_PASSWORD", "admin123")
    senha_adv = os.getenv("SEED_ADVOGADO_PASSWORD", "marina123")

    # Garante que as tabelas existem
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    # Limpa dados anteriores (ordem respeita as foreign keys)
    db.query(models.Document).delete()
    db.query(models.Appointment).delete()
    db.query(models.Deadline).delete()
    db.query(models.Process).delete()
    db.query(models.Client).delete()
    db.query(models.User).delete()
    db.commit()

    # --- Usuários ---
    admin = models.User(
        name="Dr. Administrador",
        email="admin@escritorio.com",
        password_hash=hash_password(senha_admin),
        role="admin",
    )
    advogado = models.User(
        name="Dra. Marina Costa",
        email="marina@escritorio.com",
        password_hash=hash_password(senha_adv),
        role="advogado",
    )
    db.add_all([admin, advogado])
    db.commit()

    # --- Clientes (em diferentes etapas do funil) ---
    clientes = [
        models.Client(name="João da Silva", cpf_cnpj="123.456.789-00",
                      phone="(11) 98765-4321", email="joao@exemplo.test",
                      status="ativo", notes="Cliente desde 2023."),
        models.Client(name="Maria Oliveira", cpf_cnpj="987.654.321-00",
                      phone="(11) 91234-5678", email="maria@exemplo.test",
                      status="ativo"),
        models.Client(name="Tech Solutions LTDA", cpf_cnpj="12.345.678/0001-90",
                      phone="(11) 3344-5566", email="contato@techsolutions.test",
                      status="negociacao", notes="Contrato em análise."),
        models.Client(name="Carlos Pereira", cpf_cnpj="111.222.333-44",
                      phone="(21) 99888-7766", email="carlos@exemplo.test",
                      status="lead", notes="Indicação de cliente."),
        models.Client(name="Ana Souza", cpf_cnpj="555.666.777-88",
                      phone="(31) 97777-1234", email="ana@exemplo.test",
                      status="lead"),
        models.Client(name="Construtora Horizonte", cpf_cnpj="98.765.432/0001-10",
                      phone="(11) 4000-1234", email="juridico@horizonte.test",
                      status="arquivado", notes="Caso encerrado em 2024."),
    ]
    db.add_all(clientes)
    db.commit()

    joao, maria, tech, carlos, ana, construtora = clientes

    # --- Processos (todo processo ligado a um cliente) ---
    processos = [
        models.Process(client_id=joao.id, case_number="0001234-56.2024.8.26.0100",
                       type="trabalhista", status="ativo",
                       description="Reclamação trabalhista por verbas rescisórias."),
        models.Process(client_id=maria.id, case_number="0007890-12.2024.8.26.0011",
                       type="civil", status="ativo",
                       description="Ação de indenização por danos morais."),
        models.Process(client_id=tech.id, case_number="0004567-89.2025.8.26.0050",
                       type="tributario", status="ativo",
                       description="Discussão sobre cobrança de ICMS."),
        models.Process(client_id=construtora.id, case_number="0009999-00.2023.8.26.0002",
                       type="civil", status="encerrado",
                       description="Disputa contratual de obra. Sentença favorável."),
    ]
    db.add_all(processos)
    db.commit()

    p_joao, p_maria, p_tech, p_const = processos

    # --- Prazos (todo prazo ligado a um processo) ---
    hoje = date.today()
    prazos = [
        models.Deadline(process_id=p_joao.id, date=hoje + timedelta(days=2),
                        description="Apresentar contestação", urgency_level="alta"),
        models.Deadline(process_id=p_joao.id, date=hoje + timedelta(days=15),
                        description="Juntar documentos comprobatórios", urgency_level="media"),
        models.Deadline(process_id=p_maria.id, date=hoje + timedelta(days=5),
                        description="Recurso de apelação", urgency_level="alta"),
        models.Deadline(process_id=p_tech.id, date=hoje + timedelta(days=30),
                        description="Manifestação sobre laudo pericial", urgency_level="baixa"),
        models.Deadline(process_id=p_tech.id, date=hoje - timedelta(days=3),
                        description="Protocolo de petição inicial", urgency_level="media", done=1),
    ]
    db.add_all(prazos)
    db.commit()

    # --- Audiências (agenda) ---
    agora = datetime.now()
    audiencias = [
        models.Appointment(process_id=p_joao.id,
                           date_time=agora + timedelta(days=3, hours=2),
                           location="Fórum Trabalhista de São Paulo - Sala 12",
                           notes="Audiência de instrução e julgamento."),
        models.Appointment(process_id=p_maria.id,
                           date_time=agora + timedelta(days=10, hours=4),
                           location="Fórum Central - 2ª Vara Cível",
                           notes="Audiência de conciliação."),
        models.Appointment(process_id=p_tech.id,
                           date_time=agora + timedelta(days=20),
                           location="Online (videoconferência)",
                           notes="Sessão de julgamento."),
    ]
    db.add_all(audiencias)
    db.commit()

    db.close()

    print("=" * 50)
    print("Seed concluído com sucesso!")
    print("=" * 50)
    print("Usuários criados:")
    print("  ADMIN     -> admin@escritorio.com   / admin123")
    print("  Advogado  -> marina@escritorio.com  / marina123")
    print("=" * 50)


if __name__ == "__main__":
    run()
