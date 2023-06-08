import FS from 'fs';
import { format } from 'util';

const defs = JSON.parse(FS.readFileSync('./amqp-rabbitmq-0.9.1.json', 'utf-8'))

const FRAME_OVERHEAD = 8; // type + channel + size + frame-end

const METHOD_OVERHEAD = FRAME_OVERHEAD + 4;
// F_O + classId + methodId

const PROPERTIES_OVERHEAD = FRAME_OVERHEAD + 4 + 8 + 2;
// F_O + classId + weight + content size + flags


const out = process.stdout;

function printf() {
  out.write(format.apply(format, arguments), 'utf8');
}

function nl() { out.write('\n'); }
function println() { printf.apply(printf, arguments); nl(); }

function isEmptyObject(val) {
  return (val != null && typeof val === 'object' &&
          Object.keys(val).length === 0);
}

function stringifyValue(val) {
  return (isEmptyObject(val)) ? 'EMPTY_OBJECT' :
    JSON.stringify(val);
}

const constants = {};
const constant_strs = {};

for (let i = 0, len = defs.constants.length; i < len; i++) {
  const cdef = defs.constants[i];
  constants[constantName(cdef)] = cdef.value;
  constant_strs[cdef.value] = cdef.name;
}

function constantName(def) {
  return def.name.replace(/-/g, '_');
}

function methodName(clazz, method) {
  return initial(clazz.name) + method.name.split('-').map(initial).join('');
}

function propertyName(dashed) {
  const parts = dashed.split('-');
  return parts[0] + parts.slice(1).map(initial).join('');
}

function initial(part) {
  return part.charAt(0).toUpperCase() + part.substr(1);
}

function argument(a) {
  const type = a.type || domains[a.domain];
  const friendlyName = propertyName(a.name);
  return {type: type, name: friendlyName, default: a['default-value']};
}

const domains = {};
for (let i=0, len = defs.domains.length; i < len; i++) {
  const dom = defs.domains[i];
  domains[dom[0]] = dom[1];
}

const methods = {};
const propertieses = {};

for (let i = 0, len = defs.classes.length; i < len; i++) {
  const clazz = defs.classes[i];
  for (let j = 0, num = clazz.methods.length; j < num; j++) {
    const method = clazz.methods[j];
    const name = methodName(clazz, method);
    const info = 'methodInfo' + name;

    methods[name] = {
      id: methodId(clazz, method),
      name: name,
      methodId: method.id,
      clazzId: clazz.id,
      clazz: clazz.name,
      args: method['arguments'].map(argument),
      isReply: method.answer,
      encoder: 'encode' + name,
      decoder: 'decode' + name,
      info: info
    };
  }
  if (clazz.properties && clazz.properties.length > 0) {
    const name = propertiesName(clazz);
    const props = clazz.properties;
    propertieses[name] = {
      id: clazz.id,
      name: name,
      encoder: 'encode' + name,
      decoder: 'decode' + name,
      info: 'propertiesInfo' + name,
      args: props.map(argument),
    };
  }
}

// OK let's get emitting

println(
'/** @preserve This file is generated by the script\n',
'* ../bin/generate-defs.js, which is not in general included in a\n',
'* distribution, but is available in the source repository e.g. at\n',
'* https://github.com/squaremo/amqp.node/\n',
'*/');

nl()
println('import { encodeTable, decodeFields } from "./codec.js";');
println('import ints from "buffer-more-ints";');
nl();

println('const SCRATCH = Buffer.alloc(65536);');
println('const EMPTY_OBJECT = Object.freeze({});');

println('export const constants = %s',
        JSON.stringify(constants));
nl();
println('export const constant_strs = %s',
        JSON.stringify(constant_strs));
nl();
println('export const FRAME_OVERHEAD = %d;', FRAME_OVERHEAD);
nl();

println('export function decode(id, buf) {');
println('switch (id) {');
for (let m in methods) {
  const method = methods[m];
  println('case %d: return %s(buf);', method.id, method.decoder);
}
for (let p in propertieses) {
  const props = propertieses[p];
  println('case %d: return %s(buf);', props.id,  props.decoder);
}
println('default: throw new Error("Unknown class/method ID");');
println('}}'); nl();

println('export function encodeMethod(id, channel, fields) {');
println('switch (id) {');
for (let m in methods) {
  const method = methods[m];
  println('case %d: return %s(channel, fields);',
          method.id, method.encoder);
}
println('default: throw new Error("Unknown class/method ID");');
println('}}'); nl();

println('export function encodeProperties',
        '(id, channel, size, fields) {');
println('switch (id) {');
for (let p in propertieses) {
  const props = propertieses[p];
  println('case %d: return %s(channel, size, fields);',
          props.id, props.encoder);
}
println('default: throw new Error("Unknown class/properties ID");');
println('}}'); nl();

println('export function info(id) {');
println('switch(id) {');
for (let m in methods) {
  const method = methods[m];
  println('case %d: return %s; ', method.id, method.info);
}
for (let p in propertieses) {
  const properties = propertieses[p];
  println('case %d: return %s', properties.id, properties.info);
}
println('default: throw new Error("Unknown class/method ID");');
println('}}'); nl();

for (let m in methods) {
  const method = methods[m];
  println('export const %s = %d;', m, method.id);
  decoderFn(method); nl();
  encoderFn(method); nl();
  infoObj(method); nl();
}

for (let p in propertieses) {
  const properties = propertieses[p];
  println('export const %s = %d;', p, properties.id);
  encodePropsFn(properties); nl();
  decodePropsFn(properties); nl();
  infoObj(properties); nl();
}

function methodId(clazz, method) {
  return (clazz.id << 16) + method.id;
}

function propertiesName(clazz) {
  return initial(clazz.name) + 'Properties';
}

function valTypeTest(arg) {
  switch (arg.type) {
  // everything is booleany
  case 'bit':       return 'true'
  case 'octet':
  case 'short':
  case 'long':
  case 'longlong':
  case 'timestamp': return "typeof val === 'number' && !isNaN(val)";
  case 'shortstr':  return "typeof val === 'string' &&" +
      " Buffer.byteLength(val) < 256";
  case 'longstr':   return "Buffer.isBuffer(val)";
  case 'table':     return "typeof val === 'object'";
  }
}

function typeDesc(t) {
  switch (t) {
  case 'bit':       return 'booleany';
  case 'octet':
  case 'short':
  case 'long':
  case 'longlong':
  case 'timestamp': return "a number (but not NaN)";
  case 'shortstr':  return "a string (up to 255 chars)";
  case 'longstr':   return "a Buffer";
  case 'table':     return "an object";
  }
}

function defaultValueRepr(arg) {
  switch (arg.type) {
  case 'longstr':
    return format("Buffer.from(%s)", JSON.stringify(arg.default));
  default:
    // assumes no tables as defaults
    return JSON.stringify(arg.default);
  }
}

// Emit code to assign the arg value to `val`.
function assignArg(a) {
  println("val = fields['%s'];", a.name);
}

function assignOrDefault(a) {
  println("val = fields['%s'];", a.name);
  println("if (val === undefined) val = %s;", defaultValueRepr(a));
}

// Emit code for assigning an argument value to `val`, checking that
// it exists (if it does not have a default) and is the correct
// type.
function checkAssignArg(a) {
  assignArg(a);
  println('if (val === undefined) {');
  if (a.default !== undefined) {
    println('val = %s;', defaultValueRepr(a));
  }
  else {
    println('throw new Error("Missing value for mandatory field \'%s\'");', a.name);
  }
  println('}'); // undefined test
  println('else if (!(%s)) {', valTypeTest(a));
  println('throw new TypeError(');
  println('"Field \'%s\' is the wrong type; must be %s");',
          a.name, typeDesc(a.type));
  println('}'); // type test
}

// Emit code for encoding `val` as a table and assign to a fresh
// variable (based on the arg name). I use a scratch buffer to compose
// the encoded table, otherwise I'd have to do a size calculation pass
// first. I can get away with this only because 1. the encoding
// procedures are not re-entrant; and, 2. I copy the result into
// another buffer before returning. `scratchOffset`, `val`, `len` are
// expected to have been declared.
function assignTable(a) {
  const varname = tableVar(a);
  println(
    "len = encodeTable(SCRATCH, val, scratchOffset);");
  println('const %s = SCRATCH.slice(scratchOffset, scratchOffset + len);', varname);
  println('scratchOffset += len;');
}

function tableVar(a) {
  return a.name + '_encoded';
}

function stringLenVar(a) {
  return a.name + '_len';
}

function assignStringLen(a) {
  const v = stringLenVar(a);
  // Assumes the value or default is in val
  println("const %s = Buffer.byteLength(val, 'utf8');", v);
}


function encoderFn(method) {
  const args = method['args'];
  println('function %s(channel, fields) {', method.encoder);
  println('let offset = 0, val = null, bits = 0, varyingSize = 0;');
  println('let len, scratchOffset = 0;');

  // Encoding is split into two parts. Some fields have a fixed size
  // (e.g., integers of a specific width), while some have a size that
  // depends on the datum (e.g., strings). Each field will therefore
  // either 1. contribute to the fixed size; or 2. emit code to
  // calculate the size (and possibly the encoded value, in the case
  // of tables).
  let fixedSize = METHOD_OVERHEAD;

  let bitsInARow = 0;

  for (let i=0, len = args.length; i < len; i++) {
    const arg = args[i];

    if (arg.type != 'bit') bitsInARow = 0;

    switch (arg.type) {
    // varying size
    case 'shortstr':
      checkAssignArg(arg);
      assignStringLen(arg);
      println("varyingSize += %s;", stringLenVar(arg));
      fixedSize += 1;
      break;
    case 'longstr':
      checkAssignArg(arg);
      println("varyingSize += val.length;");
      fixedSize += 4;
      break;
    case 'table':
      // For a table we have to encode the table before we can see its
      // length.
      checkAssignArg(arg);
      assignTable(arg);
      println('varyingSize += %s.length;', tableVar(arg));
      break;

    // fixed size
    case 'octet': fixedSize += 1; break;
    case 'short': fixedSize += 2; break;
    case 'long': fixedSize += 4; break;
    case 'longlong': //fall through
    case 'timestamp':
      fixedSize += 8; break;
    case 'bit':
      bitsInARow ++;
      // open a fresh pack o' bits
      if (bitsInARow === 1) fixedSize += 1;
      // just used a pack; reset
      else if (bitsInARow === 8) bitsInARow = 0;
      break;
    }
  }

  println('const buffer = Buffer.alloc(%d + varyingSize);', fixedSize);

  println('buffer[0] = %d;', constants.FRAME_METHOD);
  println('buffer.writeUInt16BE(channel, 1);');
  // skip size for now, we'll write it in when we know
  println('buffer.writeUInt32BE(%d, 7);', method.id);
  println('offset = 11;');

  bitsInARow = 0;

  for (let i = 0, len = args.length; i < len; i++) {
    const a = args[i];

    // Flush any collected bits before doing a new field
    if (a.type != 'bit' && bitsInARow > 0) {
      bitsInARow = 0;
      println('buffer[offset] = bits; offset++; bits = 0;');
    }

    switch (a.type) {
    case 'octet':
      checkAssignArg(a);
      println('buffer.writeUInt8(val, offset); offset++;');
      break;
    case 'short':
      checkAssignArg(a);
      println('buffer.writeUInt16BE(val, offset); offset += 2;');
      break;
    case 'long':
      checkAssignArg(a);
      println('buffer.writeUInt32BE(val, offset); offset += 4;');
      break;
    case 'longlong':
    case 'timestamp':
      checkAssignArg(a);
      println('ints.writeUInt64BE(buffer, val, offset); offset += 8;');
      break;
    case 'bit':
      checkAssignArg(a);
      println('if (val) bits += %d;', 1 << bitsInARow);
      if (bitsInARow === 7) { // I don't think this ever happens, but whatever
        println('buffer[offset] = bits; offset++; bits = 0;');
        bitsInARow = 0;
      }
      else bitsInARow++;
      break;
    case 'shortstr':
      assignOrDefault(a);
      println('buffer[offset] = %s; offset++;', stringLenVar(a));
      println('buffer.write(val, offset, "utf8"); offset += %s;',
              stringLenVar(a));
      break;
    case 'longstr':
      assignOrDefault(a);
      println('len = val.length;');
      println('buffer.writeUInt32BE(len, offset); offset += 4;');
      println('val.copy(buffer, offset); offset += len;');
      break;
    case 'table':
      println('offset += %s.copy(buffer, offset);', tableVar(a));
      break;
    default: throw new Error("Unexpected argument type: " + a.type);
    }
  }

  // Flush any collected bits at the end
  if (bitsInARow > 0) {
    println('buffer[offset] = bits; offset++;');
  }

  println('buffer[offset] = %d;', constants.FRAME_END);
  // size does not include the frame header or frame end byte
  println('buffer.writeUInt32BE(offset - 7, 3);');

  println('return buffer;');
  println('}');
}

function fieldsDecl(args) {
  println('const fields = {');
  for (let i=0, num=args.length; i < num; i++) {
    println('%s: undefined,', args[i].name);
  }
  println('};');
}

function decoderFn(method) {
  const args = method.args;
  println('function %s(buffer) {', method.decoder);
  println('let offset = 0, val, len;');
  fieldsDecl(args);

  let bitsInARow = 0;

  for (let i=0, num=args.length; i < num; i++) {
    const a = args[i];
    const field = "fields['" + a.name + "']";

    // Flush any collected bits before doing a new field
    if (a.type != 'bit' && bitsInARow > 0) {
      bitsInARow = 0;
      println('offset++;');
    }

    switch (a.type) {
    case 'octet':
      println('val = buffer[offset]; offset++;');
      break;
    case 'short':
      println('val = buffer.readUInt16BE(offset); offset += 2;');
      break;
    case 'long':
      println('val = buffer.readUInt32BE(offset); offset += 4;');
      break;
    case 'longlong':
    case 'timestamp':
      println('val = ints.readUInt64BE(buffer, offset); offset += 8;');
      break;
    case 'bit':
      const bit = 1 << bitsInARow;
      println('val = !!(buffer[offset] & %d);', bit);
      if (bitsInARow === 7) {
        println('offset++;');
        bitsInARow = 0;
      }
      else bitsInARow++;
      break;
    case 'longstr':
      println('len = buffer.readUInt32BE(offset); offset += 4;');
      println('val = buffer.slice(offset, offset + len);');
      println('offset += len;');
      break;
    case 'shortstr':
      println('len = buffer.readUInt8(offset); offset++;');
      println('val = buffer.toString("utf8", offset, offset + len);');
      println('offset += len;');
      break;
    case 'table':
      println('len = buffer.readUInt32BE(offset); offset += 4;');
      println('val = decodeFields(buffer.slice(offset, offset + len));');
      println('offset += len;');
      break;
    default:
      throw new TypeError("Unexpected type in argument list: " + a.type);
    }
    println('%s = val;', field);
  }
  println('return fields;');
  println('}');
}

function infoObj(thing) {
  const info = JSON.stringify({id: thing.id,
                             classId: thing.clazzId,
                             methodId: thing.methodId,
                             name: thing.name,
                             args: thing.args});
  println('export let %s = %s', thing.info, info)
}

// The flags are laid out in groups of fifteen in a short (high to
// low bits), with a continuation bit (at 0) and another group
// following if there's more than fifteen. Presence and absence
// are conflated with true and false, for bit fields (i.e., if the
// flag for the field is set, it's true, otherwise false).
//
// However, none of that is actually used in AMQP 0-9-1. The only
// instance of properties -- basic properties -- has 14 fields, none
// of them bits.

function flagAt(index) {
  return 1 << (15 - index);
}

function encodePropsFn(props) {
  println('function %s(channel, size, fields) {', props.encoder);
  println('let offset = 0, flags = 0, val, len;');
  println('let scratchOffset = 0, varyingSize = 0;');

  const fixedSize = PROPERTIES_OVERHEAD;

  const args = props.args;

  function incVarying(by) {
    println("varyingSize += %d;", by);
  }

  for (let i=0, num=args.length; i < num; i++) {
    const p = args[i];

    assignArg(p);
    println("if (val != undefined) {");

    println("if (%s) {", valTypeTest(p));
    switch (p.type) {
    case 'shortstr':
      assignStringLen(p);
      incVarying(1);
      println('varyingSize += %s;', stringLenVar(p));
      break;
    case 'longstr':
      incVarying(4);
      println('varyingSize += val.length;');
      break;
    case 'table':
      assignTable(p);
      println('varyingSize += %s.length;', tableVar(p));
      break;
    case 'octet': incVarying(1); break;
    case 'short': incVarying(2); break;
    case 'long': incVarying(4); break;
    case 'longlong': // fall through
    case 'timestamp':
      incVarying(8); break;
      // no case for bit, as they are accounted for in the flags
    }
    println('} else {');
    println('throw new TypeError(');
    println('"Field \'%s\' is the wrong type; must be %s");',
            p.name, typeDesc(p.type));
    println('}');
    println('}');
  }

  println('const buffer = Buffer.alloc(%d + varyingSize);', fixedSize);

  println('buffer[0] = %d', constants.FRAME_HEADER);
  println('buffer.writeUInt16BE(channel, 1);');
  // content class ID and 'weight' (== 0)
  println('buffer.writeUInt32BE(%d, 7);', props.id << 16);
  // skip frame size for now, we'll write it in when we know.

  // body size
  println('ints.writeUInt64BE(buffer, size, 11);');

  println('flags = 0;');
  // we'll write the flags later too
  println('offset = 21;');

  for (let i=0, num=args.length; i < num; i++) {
    const p = args[i];
    const flag = flagAt(i);

    assignArg(p);
    println("if (val != undefined) {");
    if (p.type === 'bit') { // which none of them are ..
      println('if (val) flags += %d;', flag);
    }
    else {
      println('flags += %d;', flag);
      // %%% FIXME only slightly different to the method args encoding
      switch (p.type) {
      case 'octet':
        println('buffer.writeUInt8(val, offset); offset++;');
        break;
      case 'short':
        println('buffer.writeUInt16BE(val, offset); offset += 2;');
        break;
      case 'long':
        println('buffer.writeUInt32BE(val, offset); offset += 4;');
        break;
      case 'longlong':
      case 'timestamp':
        println('ints.writeUInt64BE(buffer, val, offset);');
        println('offset += 8;');
        break;
      case 'shortstr':
        const v = stringLenVar(p);
        println('buffer[offset] = %s; offset++;', v);
        println("buffer.write(val, offset, 'utf8');");
        println("offset += %s;", v);
        break;
      case 'longstr':
        println('buffer.writeUInt32BE(val.length, offset);');
        println('offset += 4;');
        println('offset += val.copy(buffer, offset);');
        break;
      case 'table':
        println('offset += %s.copy(buffer, offset);', tableVar(p));
        break;
      default: throw new Error("Unexpected argument type: " + p.type);
      }
    }
    println('}'); // != undefined
  }

  println('buffer[offset] = %d;', constants.FRAME_END);
  // size does not include the frame header or frame end byte
  println('buffer.writeUInt32BE(offset - 7, 3);');
  println('buffer.writeUInt16BE(flags, 19);');
  println('return buffer.slice(0, offset + 1);');
  println('}');
}

function decodePropsFn(props) {
  const args = props.args;

  println('function %s(buffer) {', props.decoder);
  println('let flags, offset = 2, val, len;');

  println('flags = buffer.readUInt16BE(0);');
  println('if (flags === 0) return {};');

  fieldsDecl(args);

  for (let i=0, num=args.length; i < num; i++) {
    const p = argument(args[i]);
    const field = "fields['" + p.name + "']";

    println('if (flags & %d) {', flagAt(i));
    if (p.type === 'bit') {
      println('%d = true;', field);
    }
    else {
      switch (p.type) {
      case 'octet':
        println('val = buffer[offset]; offset++;');
        break;
      case 'short':
        println('val = buffer.readUInt16BE(offset); offset += 2;');
        break;
      case 'long':
        println('val = buffer.readUInt32BE(offset); offset += 4;');
        break;
      case 'longlong':
      case 'timestamp':
        println('val = ints.readUInt64BE(buffer, offset); offset += 8;');
        break;
      case 'longstr':
        println('len = buffer.readUInt32BE(offset); offset += 4;');
        println('val = buffer.slice(offset, offset + len);');
        println('offset += len;');
        break;
      case 'shortstr':
        println('len = buffer.readUInt8(offset); offset++;');
        println('val = buffer.toString("utf8", offset, offset + len);');
        println('offset += len;');
        break;
      case 'table':
        println('len = buffer.readUInt32BE(offset); offset += 4;');
        println('val = decodeFields(buffer.slice(offset, offset + len));');
        println('offset += len;');
        break;
      default:
        throw new TypeError("Unexpected type in argument list: " + p.type);
      }
      println('%s = val;', field);
    }
    println('}');
  }
  println('return fields;');
  println('}');
}
