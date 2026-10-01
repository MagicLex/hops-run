"""Create or update the Kumo Tabular deployment that decides Hops Run moves.

Needs the model in the registry (nvidia/Kumo-Tabular imported from HuggingFace) and an inference
environment with requirements.txt installed. Reads HOPSWORKS_HOST, HOPSWORKS_API_KEY and
HOPSWORKS_PROJECT (hopsworks.login defaults):

    python kumo/deploy.py [--model Kumo_Tabular] [--name kumo] [--size small] [--holdout 0.3]
"""

import argparse
import pathlib

import hopsworks
from hsml.resources import PredictorResources, Resources

HERE = pathlib.Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", default="Kumo_Tabular", help="Model registry name")
    parser.add_argument("--model-version", type=int, default=None, help="Model version; latest when omitted")
    parser.add_argument("--name", default="kumo", help="Deployment name")
    parser.add_argument("--env", default="kumo-inference", help="Inference environment")
    parser.add_argument("--size", default="small", choices=["small", "medium", "large"], help="Kumo Tabular size")
    parser.add_argument("--holdout", type=float, default=0.3, help="Share of game situations held out of the context")
    parser.add_argument("--cores", type=int, default=2, help="CPU cores requested and limited")
    parser.add_argument("--memory", type=int, default=4096, help="Memory limit in MB")
    parser.add_argument("--gpus", type=int, default=0, help="GPUs per instance")
    args = parser.parse_args()

    project = hopsworks.login()
    model = project.get_model_registry().get_model(args.model, version=args.model_version)
    ms = project.get_model_serving()
    script = project.get_dataset_api().upload(str(HERE / "predictor.py"), f"Resources/{args.name}", overwrite=True)

    existing = ms.get_deployment(args.name)
    if existing is not None:
        existing.delete(force=True)

    deployment = model.deploy(
        name=args.name,
        description=f"NVIDIA Kumo Tabular ({args.size}) deciding Hops Run moves by in-context learning",
        script_file=script,
        environment=args.env,
        env_vars={"KUMO_SIZE": args.size, "KUMO_HOLDOUT": str(args.holdout), "KUMO_DEVICE": "cuda" if args.gpus else "cpu", "KUMO_THREADS": str(args.cores)},
        resources=PredictorResources(
            num_instances=1,
            requests=Resources(cores=args.cores, memory=args.memory // 2, gpus=args.gpus),
            limits=Resources(cores=args.cores, memory=args.memory, gpus=args.gpus),
        ),
        default_predictor=False,
    )
    deployment.start(await_running=1200)
    print(deployment.name, deployment.get_state().status, deployment.get_inference_url())


if __name__ == "__main__":
    main()
