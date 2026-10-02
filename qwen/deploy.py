"""Create or update the qwen pilot's deployment: SemIf on Qwen3-4B.

Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and HOPSWORKS_PROJECT from the
environment (hopsworks.login defaults):

    python qwen/deploy.py [--model Qwen3_4B] [--name semif4b] [--env jevworks-inference]
"""

import argparse
import pathlib

import hopsworks
from hsml.resources import PredictorResources, Resources

HERE = pathlib.Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", default="Qwen3_4B", help="Model registry name")
    parser.add_argument("--model-version", type=int, default=None, help="Model version; latest when omitted")
    parser.add_argument("--name", default="semif4b", help="Deployment name")
    parser.add_argument("--env", default="jevworks-inference", help="Inference environment")
    parser.add_argument("--cores", type=int, default=4, help="CPU cores requested and limited")
    parser.add_argument("--memory", type=int, default=24576, help="Memory limit in MB")
    parser.add_argument("--gpus", type=int, default=1, help="GPUs per instance")
    args = parser.parse_args()

    project = hopsworks.login()
    mr = project.get_model_registry()
    ms = project.get_model_serving()

    model = mr.get_model(args.model, version=args.model_version)
    if model.framework == "LLM":
        # HuggingFace imports of text-generation models are tagged LLM, which
        # selects vLLM. The logit readout needs the plain Python model server.
        model._update_framework("TORCH")
        model = mr.get_model(args.model, version=model.version)

    script = project.get_dataset_api().upload(
        str(HERE / "predictor.py"), f"Resources/{args.name}", overwrite=True
    )

    resources = PredictorResources(
        num_instances=1,
        requests=Resources(cores=args.cores, memory=args.memory // 2, gpus=args.gpus),
        limits=Resources(cores=args.cores, memory=args.memory, gpus=args.gpus),
    )

    existing = ms.get_deployment(args.name)
    if existing is not None:
        existing.delete(force=True)

    deployment = model.deploy(
        name=args.name,
        description="SemIf direct logit readout: option probabilities from one forward pass",
        script_file=script,
        environment=args.env,
        resources=resources,
        default_predictor=False,
    )
    deployment.start(await_running=1200)
    print(deployment.name, deployment.get_state().status, deployment.get_inference_url())


if __name__ == "__main__":
    main()
