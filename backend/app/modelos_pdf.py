"""Geração de PDF dos modelos jurídicos (procuração e contrato) por área.

Modelos com preenchimento automático dos dados do signatário (cliente ou
requerente de precatório). Foco atual: Precatórios Federais — mas as cláusulas
se adaptam para Cível e Trabalhista.
"""
import io
from datetime import datetime

MESES = ["", "janeiro", "fevereiro", "março", "abril", "maio", "junho",
         "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]

TIPO_LABEL = {"procuracao": "Procuração", "contrato": "Contrato de Honorários"}
AREA_LABEL = {"precatorios": "Precatórios Federais", "civel": "Cível", "trabalhista": "Trabalhista"}


def _x(s) -> str:
    """Escapa caracteres especiais para o mini-XML do reportlab Paragraph."""
    if s is None:
        return ""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _hoje_extenso() -> str:
    d = datetime.now()
    return f"Maceió/AL, {d.day} de {MESES[d.month]} de {d.year}."


def _header_footer(canvas, doc):
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    w, h = A4
    canvas.saveState()
    # Faixa do cabeçalho (navy + dourado)
    canvas.setFillColorRGB(0.086, 0.227, 0.372)
    canvas.rect(0, h - 2.6 * cm, w, 2.6 * cm, fill=1, stroke=0)
    canvas.setFillColorRGB(0.79, 0.63, 0.29)
    canvas.setFont("Helvetica-Bold", 17)
    canvas.drawCentredString(w / 2, h - 1.5 * cm, "LEOJURIS")
    canvas.setFillColorRGB(1, 1, 1)
    canvas.setFont("Helvetica", 9)
    canvas.drawCentredString(w / 2, h - 2.05 * cm, "Advocacia & Consultoria Jurídica")
    # Rodapé
    canvas.setFillColorRGB(0.5, 0.5, 0.5)
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(w / 2, 1.1 * cm, "Documento gerado pelo sistema — LeoJuris")
    canvas.restoreState()


def _styles():
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER, TA_RIGHT
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("title", parent=base["Normal"], fontName="Helvetica-Bold",
                                 fontSize=14, alignment=TA_CENTER, spaceAfter=18, leading=18),
        "body": ParagraphStyle("body", parent=base["Normal"], fontName="Helvetica",
                                fontSize=11, alignment=TA_JUSTIFY, leading=17, spaceAfter=10),
        "clause": ParagraphStyle("clause", parent=base["Normal"], fontName="Helvetica-Bold",
                                  fontSize=11, leading=15, spaceBefore=6, spaceAfter=3),
        "right": ParagraphStyle("right", parent=base["Normal"], fontName="Helvetica",
                                 fontSize=11, alignment=TA_RIGHT, spaceBefore=18),
        "sig": ParagraphStyle("sig", parent=base["Normal"], fontName="Helvetica",
                              fontSize=11, alignment=TA_CENTER, leading=15),
    }


def gerar_pdf(tipo: str, area: str, dados: dict) -> io.BytesIO:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=3.4 * cm, bottomMargin=2 * cm,
        leftMargin=2.3 * cm, rightMargin=2.3 * cm,
        title=f"{TIPO_LABEL.get(tipo, 'Documento')} — LeoJuris",
    )
    st = _styles()
    story = _contrato(area, dados, st) if tipo == "contrato" else _procuracao(area, dados, st)
    doc.build(story, onFirstPage=_header_footer, onLaterPages=_header_footer)
    buf.seek(0)
    return buf


def _ref_processual(area: str, d: dict) -> str:
    """Frase de referência processual conforme a área."""
    if area == "precatorios":
        partes = []
        if d.get("numero_precatorio"):
            partes.append(f"precatório nº {_x(d['numero_precatorio'])}")
        if d.get("numero_originario"):
            partes.append(f"processo originário nº {_x(d['numero_originario'])}")
        if d.get("tribunal"):
            partes.append(_x(str(d['tribunal']).upper()))
        if partes:
            return "referente ao " + ", ".join(partes)
    if d.get("processo_ref"):
        return f"referente ao processo nº {_x(d['processo_ref'])}"
    return ""


def _qualificacao(d: dict) -> str:
    nome = _x(d.get("nome") or "—")
    cpf = _x(d.get("cpf") or "—")
    txt = f"<b>{nome}</b>, inscrito(a) no CPF sob o nº {cpf}"
    if d.get("rg"):
        txt += f", portador(a) do RG nº {_x(d['rg'])}"
    if d.get("endereco"):
        txt += f", residente e domiciliado(a) em {_x(d['endereco'])}"
    extra = []
    if d.get("email"):
        extra.append(f"e-mail {_x(d['email'])}")
    if d.get("telefone"):
        extra.append(f"telefone {_x(d['telefone'])}")
    if extra:
        txt += ", " + ", ".join(extra)
    return txt


def _procuracao(area: str, d: dict, st):
    from reportlab.platypus import Paragraph, Spacer
    from reportlab.lib.units import cm
    ref = _ref_processual(area, d)
    story = [
        Paragraph("PROCURAÇÃO AD JUDICIA ET EXTRA", st["title"]),
        Paragraph(
            "<b>OUTORGANTE:</b> " + _qualificacao(d) +
            ", doravante denominado(a) OUTORGANTE.", st["body"]),
        Paragraph(
            "<b>OUTORGADO:</b> os advogados do escritório LEOJURIS, "
            "regularmente inscritos na OAB, com escritório profissional onde recebem intimações.",
            st["body"]),
        Paragraph(
            "<b>PODERES:</b> pelo presente instrumento, o(a) outorgante nomeia e constitui "
            "seus bastantes procuradores os outorgados acima, a quem confere os poderes da "
            "cláusula <i>ad judicia et extra</i>, para o foro em geral, em qualquer Juízo, "
            "Instância ou Tribunal, podendo propor as ações competentes e defendê-lo(a) nas "
            "contrárias, seguindo umas e outras até final decisão, usando os recursos legais, "
            "conferindo ainda poderes especiais para confessar, desistir, transigir, firmar "
            "compromissos ou acordos, receber e dar quitação, levantar valores e alvarás, "
            "substabelecer com ou sem reservas, agindo em conjunto ou separadamente.", st["body"]),
    ]
    if area == "precatorios":
        story.append(Paragraph(
            "Os poderes ora outorgados destinam-se especialmente ao acompanhamento, "
            "habilitação, recebimento e levantamento de valores relativos a precatório federal"
            + ((" " + ref + ".") if ref else "."), st["body"]))
    elif ref:
        story.append(Paragraph("Poderes outorgados " + ref + ".", st["body"]))

    story += [
        Spacer(1, 0.3 * cm),
        Paragraph(_hoje_extenso(), st["right"]),
        Spacer(1, 1.6 * cm),
        Paragraph("_______________________________________", st["sig"]),
        Paragraph(_x(d.get("nome") or "Outorgante"), st["sig"]),
    ]
    return story


def _contrato(area: str, d: dict, st):
    from reportlab.platypus import Paragraph, Spacer
    from reportlab.lib.units import cm
    ref = _ref_processual(area, d)
    objeto = "a prestação de serviços advocatícios pelo CONTRATADO ao CONTRATANTE"
    if area == "precatorios":
        objeto += ", para atuação em precatório federal" + ((" " + ref) if ref else "")
    elif ref:
        objeto += ", " + ref
    objeto += "."

    story = [
        Paragraph("CONTRATO DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS", st["title"]),
        Paragraph("<b>CONTRATANTE:</b> " + _qualificacao(d) + ".", st["body"]),
        Paragraph(
            "<b>CONTRATADO:</b> LEOJURIS, por seus advogados regularmente "
            "inscritos na OAB.", st["body"]),
    ]
    clausulas = [
        ("CLÁUSULA 1ª — DO OBJETO", "O presente contrato tem por objeto " + objeto),
        ("CLÁUSULA 2ª — DOS HONORÁRIOS",
         "Pelos serviços prestados, o CONTRATANTE pagará ao CONTRATADO honorários "
         + ("no percentual de ______% (____________) sobre o valor efetivamente recebido, "
            "a título de honorários contratuais, além dos honorários de sucumbência."
            if area == "precatorios" else
            "no valor de R$ __________ (______________________), na forma e nas datas ajustadas entre as partes.")),
        ("CLÁUSULA 3ª — DAS OBRIGAÇÕES",
         "O CONTRATADO obriga-se a empregar zelo e diligência no patrocínio da causa, e o "
         "CONTRATANTE a fornecer os documentos e informações necessários ao bom andamento do trabalho."),
        ("CLÁUSULA 4ª — DO FORO",
         "Fica eleito o foro da comarca de Maceió/AL para dirimir quaisquer questões oriundas do presente contrato."),
    ]
    for titulo, texto in clausulas:
        story.append(Paragraph(titulo, st["clause"]))
        story.append(Paragraph(texto, st["body"]))

    story += [
        Spacer(1, 0.2 * cm),
        Paragraph(_hoje_extenso(), st["right"]),
        Spacer(1, 1.4 * cm),
        Paragraph("_______________________________________", st["sig"]),
        Paragraph(_x(d.get("nome") or "Contratante"), st["sig"]),
        Spacer(1, 0.9 * cm),
        Paragraph("_______________________________________", st["sig"]),
        Paragraph("LeoJuris", st["sig"]),
    ]
    return story
