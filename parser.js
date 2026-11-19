/* Leitor da ficha de treino.
 * Entrada: grade de strings (linhas x colunas), como Sheet.getDisplayValues().
 * Saída: { meta, fichas: [ { id, index, period, treinos: [ { name, label, warmup:[...], exercises:[...] } ] } ] }
 */
(function (root) {
  'use strict';

  const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();

  function normKey(name) {
    return clean(name)
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[()\[\].,:;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ---- Interpretação dos campos ----

  // "30\"" -> 30 ; "1'" -> 60 ; "2 min" -> 120 ; "60" -> 60 ; "60'" -> 60 (minutos >= 10 = provável erro de digitação)
  function parseRest(raw) {
    const s = clean(raw).toLowerCase();
    if (!s) return null;
    let m;
    if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*min/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    if ((m = s.match(/^(\d+)\s*("|''|s\b|seg)/))) return parseInt(m[1], 10);
    if ((m = s.match(/^(\d+(?:[.,]\d+)?)\s*'/))) {
      const v = parseFloat(m[1].replace(',', '.'));
      return v >= 10 ? Math.round(v) : Math.round(v * 60);
    }
    if ((m = s.match(/^(\d+)$/))) return parseInt(m[1], 10);
    return null;
  }

  // Duração de um texto como "5' bike", "30\"", "1'", "2 min" -> segundos
  function parseDuration(raw) {
    const s = clean(raw).toLowerCase();
    let m;
    if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*min/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    if ((m = s.match(/(\d+)\s*("|''|seg)/))) return parseInt(m[1], 10);
    if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*'/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    return null;
  }

  // "4x10" | "3x10/10" | "3x30\"" | "3x 8 a 10" | "3x14-12-10" | "4x50m" | "80 pulos"
  function parseSeries(raw) {
    const s = clean(raw);
    const out = { raw: s, sets: null, reps: s, unilateral: false, durationSec: null };
    if (!s) return out;
    const m = s.match(/^(\d+)\s*[x×]\s*(.*)$/i);
    if (m) {
      out.sets = parseInt(m[1], 10);
      out.reps = clean(m[2]);
    } else if (/^\d+\s*[x×]$/i.test(s)) {
      out.sets = parseInt(s, 10);
      out.reps = '';
    }
    if (/\d+\s*\/\s*\d+/.test(out.reps)) out.unilateral = true;
    // séries por tempo: 30", 60'' , 1' (mas não "4x50m" ou "3x100")
    const t = out.reps.match(/^(\d+(?:[.,]\d+)?)\s*("|''|'|s\b|seg)/i);
    if (t) {
      const v = parseFloat(t[1].replace(',', '.'));
      out.durationSec = t[2] === "'" ? (v >= 10 ? Math.round(v) : Math.round(v * 60)) : Math.round(v);
    }
    return out;
  }

  // Extrai um número em kg quando possível (para gráficos). Texto original é sempre preservado.
  function parseLoadKg(raw) {
    const s = clean(raw).toLowerCase();
    if (!s) return null;
    if (/(preto|azul|verde|vermelho|amarelo|roxo|cinza|el[aá]stico)/.test(s) && !/kg/.test(s)) return null;
    if (/barra\s+\w+\s*\+/.test(s)) return null; // "Barra grande + 35 kg": total desconhecido
    const m = s.match(/(\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    return parseFloat(m[1].replace(',', '.'));
  }

  // ---- Estrutura da planilha ----

  const isFichaStart = (c0) => /^semanas?\b/i.test(clean(c0));
  const isWarmLabel = (c) => /^aquecimento\b/i.test(clean(c));
  const isMobLabel = (c) => /^mobilidade\b/i.test(clean(c));
  const isTreinoHeader = (row, c) => /^treino\b/i.test(clean(row[c])) && /s[ée]ries/i.test(clean(row[c + 1]));

  const GROUP_STRIDE = 5;

  function parse(grid) {
    const rows = (grid || []).map((r) => (r || []).map((v) => (v == null ? '' : String(v))));
    const meta = {};
    const fichas = [];
    let ficha = null;
    let groups = null; // [{col, treino}]
    let preamble = null; // {col -> [{kind, text, label}]}

    function startFicha(row) {
      const label = clean(row[0]);
      let period = clean(row[1]);
      if (!period) {
        const rest = label.replace(/^semanas?\s*/i, '');
        period = rest ? 'Semanas ' + rest : '';
      }
      ficha = { index: fichas.length, period: period || 'Ficha ' + (fichas.length + 1), treinos: [] };
      ficha.id = 'f' + ficha.index + ':' + normKey(ficha.period);
      fichas.push(ficha);
      groups = null;
      preamble = {};
    }

    function addPreamble(row) {
      const kind = isWarmLabel(row[0]) ? 'aquecimento' : 'mobilidade';
      const maxCol = row.length;
      for (let g = 0; g < maxCol; g += GROUP_STRIDE) {
        const a = clean(row[g]);
        const b = clean(row[g + 1]);
        let text = null;
        if (isWarmLabel(a) || isMobLabel(a)) {
          const k = isWarmLabel(a) ? 'aquecimento' : 'mobilidade';
          if (k !== kind && g > 0) {
            // rótulo diferente na mesma linha: respeita o rótulo da célula
            (preamble[g] = preamble[g] || []).push({ kind: k, text: b });
            continue;
          }
          text = b;
        } else if (g > 0 && a) {
          text = b ? a + ': ' + b : a; // valor sem rótulo na coluna de outro treino
        } else {
          continue;
        }
        (preamble[g] = preamble[g] || []).push({ kind, text });
      }
    }

    function warmupFor(col) {
      const items = (preamble[col] && preamble[col].length ? preamble[col] : preamble[0]) || [];
      return items.map((it) => ({
        kind: it.kind,
        title: it.kind === 'aquecimento' ? 'Aquecimento' : 'Mobilidade',
        text: it.text || '',
        durationSec: parseDuration(it.text || ''),
      }));
    }

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const c0 = clean(row[0]);

      if (isFichaStart(c0)) { startFicha(row); continue; }

      if (!ficha) {
        if (c0 && clean(row[1])) meta[c0.toLowerCase()] = clean(row[1]);
        continue;
      }

      // cabeçalhos de treino (podem estar em várias colunas)
      const headerCols = [];
      for (let c = 0; c < row.length; c++) if (isTreinoHeader(row, c)) headerCols.push(c);
      if (headerCols.length) {
        groups = headerCols.map((col) => {
          const full = clean(row[col]).replace(/:\s*$/, '');
          const parts = full.split(':');
          const name = clean(parts[0]);
          const label = clean(parts.slice(1).join(':'));
          const treino = { name, label, warmup: warmupFor(col), exercises: [] };
          ficha.treinos.push(treino);
          return { col, treino };
        });
        continue;
      }

      if (!groups && (isWarmLabel(c0) || isMobLabel(c0))) { addPreamble(row); continue; }
      if (!groups) continue;

      for (const { col, treino } of groups) {
        const name = clean(row[col]);
        if (!name) continue;
        const seriesRaw = clean(row[col + 1]);
        const restRaw = clean(row[col + 2]);
        const loadRaw = clean(row[col + 3]);
        const series = parseSeries(seriesRaw);
        treino.exercises.push({
          name,
          key: normKey(name),
          series: seriesRaw,
          rest: restRaw,
          load: loadRaw,
          sets: series.sets,
          reps: series.reps,
          unilateral: series.unilateral,
          durationSec: series.durationSec,
          restSec: parseRest(restRaw),
          loadKg: parseLoadKg(loadRaw),
        });
      }
    }

    // remove treinos vazios e fichas vazias
    for (const f of fichas) f.treinos = f.treinos.filter((t) => t.exercises.length);
    const valid = fichas.filter((f) => f.treinos.length);
    valid.forEach((f, i) => { f.index = i; });
    return { meta, fichas: valid };
  }

  const api = { parse, parseSeries, parseRest, parseDuration, parseLoadKg, normKey, clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TreinoParser = api;
})(typeof self !== 'undefined' ? self : this);
