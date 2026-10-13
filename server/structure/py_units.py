"""Reads Python source for Tandem's structure tool. Standard library only; JSON in, JSON out.

  {"mode": "units", "source": "..."}               -> the module's top-level pieces
  {"mode": "check", "files": [{"path", "source"}]}  -> for each file: does it parse, what does it bind and use

Nothing here writes or runs the code it reads.
"""
import ast
import json
import sys

PATHY = {
    "__file__", "__name__", "__package__", "__spec__", "__path__", "__loader__", "__builtins__",
    "globals", "locals", "vars", "eval", "exec", "__import__", "compile",
}
PURE = (ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set, ast.UnaryOp, ast.BinOp, ast.BoolOp,
        ast.Compare, ast.Name, ast.Load, ast.Store, ast.operator, ast.unaryop, ast.boolop, ast.cmpop,
        ast.JoinedStr, ast.FormattedValue, ast.Lambda, ast.arguments, ast.arg, ast.Subscript,
        ast.Attribute, ast.Slice, ast.keyword, ast.IfExp, ast.Starred, ast.expr_context)


def target_names(node):
    out = []
    if isinstance(node, ast.Name):
        out.append(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            out.extend(target_names(e))
    elif isinstance(node, ast.Starred):
        out.extend(target_names(node.value))
    return out


def refs_of(node):
    return sorted({n.id for n in ast.walk(node) if isinstance(n, ast.Name)})


def is_pure(value):
    return value is None or all(isinstance(n, PURE) for n in ast.walk(value))


def bound_names(tree):
    out = set()
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                out.update(target_names(t))
        elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
            out.update(target_names(node.target))
        elif isinstance(node, ast.Import):
            for a in node.names:
                out.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                if a.name != "*":
                    out.add(a.asname or a.name)
        elif isinstance(node, (ast.For, ast.While, ast.If, ast.With, ast.Try)):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                    out.add(sub.id)
    return out


def units(source):
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"error": "syntax error: %s" % e.msg}
    lines = source.split("\n")
    out = []
    star = False
    for idx, node in enumerate(tree.body):
        start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
        end = node.end_lineno
        item = {"idx": idx, "start": start, "end": end, "type": type(node).__name__,
                "declares": [], "refs": [], "assigns": [], "pathy": False, "pure": True,
                "docstring": False, "future": False, "main_guard": False}
        item["refs"] = refs_of(node)
        item["pathy"] = any(r in PATHY for r in item["refs"])
        assigns = set()
        for sub in ast.walk(node):
            if isinstance(sub, ast.Global):
                assigns.update(sub.names)
        item["assigns"] = sorted(assigns)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            item["kind"] = "def"
            item["declares"] = [node.name]
        elif isinstance(node, ast.Assign):
            item["kind"] = "assign"
            item["declares"] = sorted({n for t in node.targets for n in target_names(t)})
            item["pure"] = is_pure(node.value)
        elif isinstance(node, ast.AnnAssign):
            item["kind"] = "assign"
            item["declares"] = target_names(node.target)
            item["pure"] = is_pure(node.value)
        elif isinstance(node, ast.Import):
            item["kind"] = "import"
            item["imports"] = [{"name": a.name, "asname": a.asname} for a in node.names]
            item["declares"] = sorted({a.asname or a.name.split(".")[0] for a in node.names})
        elif isinstance(node, ast.ImportFrom):
            item["kind"] = "from"
            item["module"] = node.module
            item["level"] = node.level
            item["imports"] = [{"name": a.name, "asname": a.asname} for a in node.names]
            item["future"] = node.module == "__future__"
            if any(a.name == "*" for a in node.names):
                star = True
            item["declares"] = sorted({a.asname or a.name for a in node.names if a.name != "*"})
        else:
            item["kind"] = "other"
            item["declares"] = sorted({n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)})
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str) and idx == 0:
                item["docstring"] = True
            if isinstance(node, ast.If) and "__name__" in item["refs"]:
                item["main_guard"] = True
        out.append(item)
    return {"units": out, "lines": len(lines), "star": star, "bound": sorted(bound_names(tree))}


def check(files):
    result = []
    for f in files:
        try:
            tree = ast.parse(f["source"])
        except SyntaxError as e:
            result.append({"path": f["path"], "error": "syntax error: %s" % e.msg})
            continue
        # Names a file uses: every Name load. Names it provides: top-level bindings.
        uses = sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)})
        result.append({"path": f["path"], "bound": sorted(bound_names(tree)), "uses": uses})
    return {"files": result}


def main():
    data = json.load(sys.stdin)
    if data.get("mode") == "units":
        print(json.dumps(units(data["source"])))
    elif data.get("mode") == "check":
        print(json.dumps(check(data["files"])))
    else:
        print(json.dumps({"error": "unknown mode"}))


main()
